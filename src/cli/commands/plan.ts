import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { getProjectPhasesDir, loadProjectConfig } from '../../core/config-manager.js';
import {
  loadProjectState,
  saveProjectState,
  createPhaseState,
  type PhaseState,
} from '../../core/state-manager.js';

interface PlanOptions {
  interactive?: boolean;
  fromReadme?: boolean;
}

export async function planCommand(options: PlanOptions): Promise<void> {
  const projectConfig = await loadProjectConfig();
  if (!projectConfig) {
    console.log(chalk.yellow('Project not initialized. Run: ai-phases init'));
    process.exit(1);
  }
  
  const state = await loadProjectState();
  if (!state) {
    console.log(chalk.yellow('Project state not found. Run: ai-phases init'));
    process.exit(1);
  }
  
  if (options.interactive) {
    await interactivePlanning(state);
  } else if (options.fromReadme) {
    await planFromReadme(state);
  } else {
    // Open plan.md for editing
    const planPath = path.join(getProjectPhasesDir(), 'plan.md');
    
    if (await fs.pathExists(planPath)) {
      console.log(chalk.white('\nExisting plan found at:'));
      console.log(chalk.cyan(`  ${planPath}\n`));
      
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: 'Edit existing plan', value: 'edit' },
            { name: 'Create new plan (interactive)', value: 'interactive' },
            { name: 'View current plan', value: 'view' },
          ],
        },
      ]);
      
      if (action === 'interactive') {
        await interactivePlanning(state);
      } else if (action === 'view') {
        const content = await fs.readFile(planPath, 'utf-8');
        console.log(chalk.dim('\n' + '─'.repeat(60) + '\n'));
        console.log(content);
        console.log(chalk.dim('\n' + '─'.repeat(60) + '\n'));
      } else {
        console.log(chalk.cyan('\nEdit the plan file and then run:'));
        console.log(chalk.white('  ai-phases plan --from-file\n'));
      }
    } else {
      console.log(chalk.white('\nNo plan exists yet. Starting interactive planning...\n'));
      await interactivePlanning(state);
    }
  }
}

async function interactivePlanning(state: any): Promise<void> {
  console.log(chalk.cyan('\n📋 Interactive Phase Planning\n'));
  
  const phases: PhaseState[] = [];
  let addMore = true;
  let phaseNumber = 1;
  
  while (addMore) {
    console.log(chalk.yellow(`\n─── Phase ${phaseNumber} ───\n`));
    
    const phaseAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Phase name:',
        default: phaseNumber === 1 ? 'Project Setup' : `Phase ${phaseNumber}`,
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description:',
      },
      {
        type: 'editor',
        name: 'tasks',
        message: 'Tasks (one per line):',
        default: '- Task 1\n- Task 2\n- Task 3',
      },
      {
        type: 'editor',
        name: 'validation',
        message: 'Validation criteria (one per line):',
        default: '- App compiles without errors\n- Basic functionality works',
      },
      {
        type: 'input',
        name: 'context7',
        message: 'Context7 docs to look up (comma-separated):',
        default: '',
      },
    ]);
    
    // Parse tasks
    const tasks = phaseAnswers.tasks
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string, index: number) => ({
        id: `task-${phaseNumber}-${index + 1}`,
        description: line.replace(/^-\s*/, '').trim(),
        status: 'pending' as const,
      }));
    
    // Parse validation criteria
    const validation = phaseAnswers.validation
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string) => line.replace(/^-\s*/, '').trim());
    
    // Parse Context7 queries
    const context7 = phaseAnswers.context7
      .split(',')
      .map((q: string) => q.trim())
      .filter(Boolean);
    
    phases.push(createPhaseState(
      phaseNumber,
      phaseAnswers.name,
      phaseAnswers.description,
      tasks,
      validation,
      context7,
      3
    ));
    
    const { continueAdding } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueAdding',
        message: 'Add another phase?',
        default: phaseNumber < 5,
      },
    ]);
    
    addMore = continueAdding;
    phaseNumber++;
  }
  
  // Save phases
  state.phases = phases;
  state.total_phases = phases.length;
  state.current_phase = 1;
  state.status = 'in_progress';
  await saveProjectState(state);
  
  // Generate plan.md
  const planContent = generatePlanMarkdown(phases);
  const planPath = path.join(getProjectPhasesDir(), 'plan.md');
  await fs.writeFile(planPath, planContent);
  
  // Create phase directories
  for (const phase of phases) {
    const phaseDir = path.join(getProjectPhasesDir(), 'phases', `phase-${phase.phase_number}`);
    await fs.ensureDir(phaseDir);
    await fs.writeJson(path.join(phaseDir, 'state.json'), phase, { spaces: 2 });
  }
  
  console.log(chalk.green('\n✓ Plan created with ' + phases.length + ' phases'));
  console.log(chalk.dim('Saved to: ') + chalk.white(planPath));
  console.log(chalk.cyan('\nRun: ai-phases run --phase 1\n'));
}

async function planFromReadme(state: any): Promise<void> {
  const readmePath = path.join(process.cwd(), 'README.md');
  
  if (!(await fs.pathExists(readmePath))) {
    console.log(chalk.yellow('No README.md found in project root.'));
    return;
  }
  
  const readmeContent = await fs.readFile(readmePath, 'utf-8');
  
  console.log(chalk.cyan('\n📖 Inferring phases from README...\n'));
  console.log(chalk.dim('README content will be used as context for phase generation.'));
  console.log(chalk.yellow('\nUse the refine command for AI-powered phase generation:'));
  console.log(chalk.cyan('  ai-phases refine "' + readmeContent.substring(0, 100).replace(/\n/g, ' ') + '..."\n'));
}

function generatePlanMarkdown(phases: PhaseState[]): string {
  let content = '# Phase Plan\n\n';
  content += `Generated: ${new Date().toISOString()}\n\n`;
  content += `Total Phases: ${phases.length}\n\n`;
  content += '---\n\n';
  
  for (const phase of phases) {
    content += `## Phase ${phase.phase_number}: ${phase.name}\n\n`;
    content += `**Description**: ${phase.description}\n\n`;
    content += `**Model**: ${phase.model === 'planning' ? 'Claude Opus' : 'Gemini Flash'}\n\n`;
    
    content += '### Tasks\n';
    phase.tasks.forEach((task, i) => {
      content += `${i + 1}. ${task.description}\n`;
    });
    content += '\n';
    
    content += '### Validation Criteria\n';
    phase.validation_criteria.forEach(criterion => {
      content += `- [ ] ${criterion}\n`;
    });
    content += '\n';
    
    if (phase.context7_queries && phase.context7_queries.length > 0) {
      content += '### Context7 Queries\n';
      phase.context7_queries.forEach(query => {
        content += `- ${query}\n`;
      });
      content += '\n';
    }
    
    content += '---\n\n';
  }
  
  return content;
}
