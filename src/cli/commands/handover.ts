import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { loadGlobalConfig, getProjectPhasesDir } from '../../core/config-manager.js';
import {
  loadProjectState,
  loadPhaseState,
  loadAttemptState,
} from '../../core/state-manager.js';
import {
  generateHandoverPrompt,
  buildCursorPrompt,
} from '../../core/prompt-builder.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface HandoverOptions {
  phase?: string;
  summarize?: boolean;
}

export async function handoverCommand(options: HandoverOptions): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig || !globalConfig.setup_complete) {
    console.log(chalk.yellow('Please run setup first: ai-phases config --setup'));
    process.exit(1);
  }
  
  const state = await loadProjectState();
  if (!state) {
    console.log(chalk.yellow('Project not initialized. Run: ai-phases init'));
    process.exit(1);
  }
  
  // Determine phase number
  let phaseNumber: number;
  if (options.phase) {
    phaseNumber = parseInt(options.phase, 10);
  } else {
    // Find the most recently completed phase
    const completedPhases = state.phases
      .filter(p => p.status === 'completed')
      .sort((a, b) => b.phase_number - a.phase_number);
    
    if (completedPhases.length === 0) {
      console.log(chalk.yellow('No completed phases found. Complete a phase first.'));
      return;
    }
    
    phaseNumber = completedPhases[0].phase_number;
  }
  
  const phase = await loadPhaseState(phaseNumber);
  if (!phase) {
    console.log(chalk.red(`Phase ${phaseNumber} not found.`));
    return;
  }
  
  console.log(chalk.cyan(`\n📋 Generating handover for Phase ${phaseNumber}: ${phase.name}\n`));
  
  // Check if handover already exists
  const handoverPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    'handover.md'
  );
  
  if (await fs.pathExists(handoverPath)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Handover already exists. Overwrite?',
        default: false,
      },
    ]);
    
    if (!overwrite) {
      console.log(chalk.dim('Existing handover:'));
      console.log(chalk.cyan(`  ${handoverPath}\n`));
      return;
    }
  }
  
  // Generate handover prompt
  const prompt = await generateHandoverPrompt(phase);
  const fullPrompt = buildCursorPrompt(prompt);
  
  // Copy to clipboard
  await copyToClipboard(fullPrompt);
  console.log(chalk.green('✓ Handover prompt copied to clipboard!\n'));
  
  // Save prompt for reference
  const promptPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    'handover-prompt.md'
  );
  await fs.writeFile(promptPath, fullPrompt);
  
  // Instructions
  console.log(chalk.yellow('┌────────────────────────────────────────────────────────────┐'));
  console.log(chalk.yellow('│ ') + chalk.white.bold('Generate Handover Summary') + chalk.yellow('                               │'));
  console.log(chalk.yellow('├────────────────────────────────────────────────────────────┤'));
  console.log(chalk.yellow('│ ') + chalk.white('1. Paste the prompt in Cursor') + chalk.yellow('                             │'));
  console.log(chalk.yellow('│ ') + chalk.white(`2. Model: ${prompt.modelName.substring(0, 30).padEnd(30)}`) + chalk.yellow('           │'));
  console.log(chalk.yellow('│ ') + chalk.white('3. Review the generated handover') + chalk.yellow('                          │'));
  console.log(chalk.yellow('│ ') + chalk.white('4. Paste the handover back here') + chalk.yellow('                           │'));
  console.log(chalk.yellow('└────────────────────────────────────────────────────────────┘\n'));
  
  // Get handover content
  const { handoverContent } = await inquirer.prompt([
    {
      type: 'editor',
      name: 'handoverContent',
      message: 'Paste the handover summary (opens editor):',
      default: getHandoverTemplate(phase),
    },
  ]);
  
  // Apply summarization if requested
  let finalContent = handoverContent;
  if (options.summarize) {
    finalContent = summarizeHandover(handoverContent);
    console.log(chalk.dim('\nSummarized handover for context efficiency.'));
  }
  
  // Save handover
  await fs.writeFile(handoverPath, finalContent);
  
  console.log(chalk.green(`\n✓ Handover saved to: ${handoverPath}`));
  
  // Show next steps
  if (phaseNumber < state.total_phases) {
    console.log(chalk.white('\nNext step:'));
    console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber + 1}\n`));
  } else {
    console.log(chalk.green('\n🎉 This was the final phase! Project complete.\n'));
  }
}

function getHandoverTemplate(phase: any): string {
  return `# Handover - Phase ${phase.phase_number}: ${phase.name}

## Completed Work
- [What was implemented]

## Files Modified
| File | Description |
|------|-------------|
| \`path/to/file\` | What this file does |

## Key Decisions
- **Decision**: [What was decided]
  - **Rationale**: [Why]

## Known Issues
- [ ] [Any issues discovered]

## Context for Next Phase
- [Important information for the next developer]

## Validation Status
${phase.validation_criteria.map((c: string) => `- [ ] ${c}`).join('\n')}
`;
}

function summarizeHandover(content: string): string {
  // Simple summarization - keep headings and first item under each
  const lines = content.split('\n');
  const summarized: string[] = [];
  let inList = false;
  let listItemCount = 0;
  const maxListItems = 3;
  
  for (const line of lines) {
    if (line.startsWith('#')) {
      summarized.push(line);
      inList = false;
      listItemCount = 0;
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.match(/^\d+\./)) {
      if (!inList || listItemCount < maxListItems) {
        summarized.push(line);
        inList = true;
        listItemCount++;
      } else if (listItemCount === maxListItems) {
        summarized.push('- ... (see full handover for details)');
        listItemCount++;
      }
    } else if (line.trim() === '') {
      summarized.push(line);
      inList = false;
      listItemCount = 0;
    } else if (!inList) {
      summarized.push(line);
    }
  }
  
  return summarized.join('\n');
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    const platform = process.platform;
    let command: string;
    
    if (platform === 'darwin') {
      command = 'pbcopy';
    } else if (platform === 'linux') {
      command = 'xclip -selection clipboard';
    } else if (platform === 'win32') {
      command = 'clip';
    } else {
      return;
    }
    
    await execAsync(`echo "${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" | ${command}`);
  } catch {
    // Silent fail
  }
}
