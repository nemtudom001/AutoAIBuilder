import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import boxen from 'boxen';
import {
  loadGlobalConfig,
  loadProjectConfig,
  saveProjectConfig,
  getProjectPhasesDir,
  runSetupWizard,
  type ProjectConfig,
} from '../../core/config-manager.js';
import { createInitialState, saveProjectState } from '../../core/state-manager.js';
import { initGitRepo, getBaseCommit } from '../../core/git-integration.js';
import { refineCommand } from './refine.js';

interface InitOptions {
  ui?: string;
  design?: string;
  fromIdea?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  // Check for global config first
  let globalConfig = await loadGlobalConfig();
  
  if (!globalConfig || !globalConfig.setup_complete) {
    globalConfig = await runSetupWizard();
  }
  
  // Check if already initialized
  const existingConfig = await loadProjectConfig();
  if (existingConfig) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'This project is already initialized. Reinitialize?',
        default: false,
      },
    ]);
    
    if (!overwrite) {
      console.log(chalk.dim('Initialization cancelled.'));
      return;
    }
  }
  
  console.log(
    boxen(
      chalk.bold.cyan('🚀 Initialize AI Phase Builder'),
      {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'cyan',
      }
    )
  );
  
  // Gather project info
  const projectName = path.basename(process.cwd());
  
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Project name:',
      default: projectName,
    },
    {
      type: 'list',
      name: 'ui_library',
      message: 'UI library:',
      choices: ['shadcn', 'radix', 'chakra', 'none'],
      default: options.ui || globalConfig.defaults.ui_library,
    },
    {
      type: 'list',
      name: 'design_system',
      message: 'Design principles:',
      choices: ['vercel', 'apple', 'material', 'custom'],
      default: options.design || globalConfig.defaults.design_system,
    },
  ]);
  
  const spinner = ora('Setting up project structure...').start();
  
  try {
    // Create directory structure
    const phasesDir = getProjectPhasesDir();
    
    await fs.ensureDir(phasesDir);
    await fs.ensureDir(path.join(phasesDir, 'phases'));
    await fs.ensureDir(path.join(phasesDir, 'logs'));
    await fs.ensureDir(path.join(phasesDir, 'templates'));
    
    // Create project config
    const projectConfig: ProjectConfig = {
      project_name: answers.name,
      created_at: new Date().toISOString(),
      ui_library: answers.ui_library,
      design_system: answers.design_system,
      total_phases: 0,
      current_phase: 0,
      current_attempt: 0,
      status: 'planning',
    };
    
    await saveProjectConfig(projectConfig);
    
    // Create initial templates
    await createTemplates(phasesDir, answers.ui_library, answers.design_system);
    
    // Initialize git if needed
    await initGitRepo();
    
    // Create initial state
    const baseCommit = await getBaseCommit();
    const state = await createInitialState(answers.name, options.fromIdea || '');
    state.git_base_commit = baseCommit;
    await saveProjectState(state);
    
    // Create context.md
    await createContextFile(phasesDir, answers);
    
    spinner.succeed('Project structure created!');
    
    // Show summary
    console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green.bold('  ✅ Project Initialized!'));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    console.log(chalk.dim('Created structure:'));
    console.log(chalk.white('  .ai-phases/'));
    console.log(chalk.dim('  ├── config.json       ') + chalk.cyan('# Project settings'));
    console.log(chalk.dim('  ├── state.json        ') + chalk.cyan('# Phase tracking'));
    console.log(chalk.dim('  ├── context.md        ') + chalk.cyan('# Persistent context'));
    console.log(chalk.dim('  ├── phases/           ') + chalk.cyan('# Phase directories'));
    console.log(chalk.dim('  ├── logs/             ') + chalk.cyan('# Decision logs'));
    console.log(chalk.dim('  └── templates/        ') + chalk.cyan('# Prompt templates'));
    console.log();
    
    // If --from-idea was provided, run refine
    if (options.fromIdea) {
      console.log(chalk.cyan('\nStarting idea refinement...\n'));
      await refineCommand(options.fromIdea, {});
    } else {
      console.log(chalk.white('Next steps:\n'));
      console.log(chalk.cyan('  ai-phases refine "your project idea"'));
      console.log(chalk.dim('  or'));
      console.log(chalk.cyan('  ai-phases plan --interactive\n'));
    }
    
  } catch (error) {
    spinner.fail('Failed to initialize project');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(1);
  }
}

async function createTemplates(
  phasesDir: string,
  uiLibrary: string,
  designSystem: string
): Promise<void> {
  // Handover template
  const handoverTemplate = `# Handover - Phase [N]: [Name]

## Completed Work
- [What was implemented]

## Files Modified
| File | Description |
|------|-------------|
| \`path/to/file\` | What this file does |

## Key Decisions
- **Decision**: [What was decided]
  - **Rationale**: [Why]
  - **Trade-offs**: [What we gave up]

## Known Issues
- [ ] [Issue description]

## Context for Next Phase
- [Important information for the next developer]

## Warnings / Gotchas
- ⚠️ [Something to watch out for]

## Validation Status
- [ ] [Criterion 1]
- [ ] [Criterion 2]
`;

  const failureTemplate = `# Failure Report - Phase [N], Attempt [M]

## Date
[ISO timestamp]

## What Was Attempted
[Describe what the phase tried to accomplish]

## What Went Wrong
[Describe the error or failure]

## Error Details
\`\`\`
[Error messages, stack traces, etc.]
\`\`\`

## Root Cause Analysis
[Why did this happen?]

## Suggested Fix for Next Attempt
[What should be done differently]

## Files That May Need Attention
- \`path/to/file\` - [Why]
`;

  const phasePromptTemplate = `# Phase [N]: [Name]

## Model
[Model to use: Claude Opus / Gemini Flash]

## Context
[Phase description and goals]

## Previous Phase Handover
[If applicable, summary from previous phase]

## Documentation Lookup (Context7)
Before coding, use @context7 to look up:
- [Library/framework topic]

## Tasks
1. [Task 1]
2. [Task 2]

## Validation Criteria
- [ ] [How to verify completion]

## Design Constraints
- UI Library: ${uiLibrary}
- Design System: ${designSystem}

## Rules
- Only modify files relevant to this phase
- Don't refactor unrelated code
- Test each change before moving on
`;

  await fs.writeFile(path.join(phasesDir, 'templates', 'handover.md'), handoverTemplate);
  await fs.writeFile(path.join(phasesDir, 'templates', 'failure-report.md'), failureTemplate);
  await fs.writeFile(path.join(phasesDir, 'templates', 'phase-prompt.md'), phasePromptTemplate);
}

async function createContextFile(
  phasesDir: string,
  config: { name: string; ui_library: string; design_system: string }
): Promise<void> {
  const contextContent = `# Project Context - ${config.name}

This file contains persistent context that carries across all phases.
It's automatically included in prompts and handovers.

## Project Overview
[To be filled after refinement]

## Technical Stack
- **UI Library**: ${config.ui_library}
- **Design System**: ${config.design_system}

## Design Tokens
[To be extracted from design system]

## Architecture Decisions
[Record important decisions here]

## Component Library
[Available components will be listed here]

## API Contracts
[External APIs and their schemas]

## Known Constraints
[Technical or business constraints]

---
*This file is managed by AI Phase Builder*
`;

  await fs.writeFile(path.join(phasesDir, 'context.md'), contextContent);
}
