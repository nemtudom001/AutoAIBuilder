import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import boxen from 'boxen';
import { loadGlobalConfig, getProjectPhasesDir } from '../../core/config-manager.js';
import {
  loadProjectState,
  saveProjectState,
  loadPhaseState,
  updatePhaseState,
  createNewAttempt,
  markAttemptCompleted,
  markAttemptFailed,
} from '../../core/state-manager.js';
import {
  generatePhaseExecutionPrompt,
  buildCursorPrompt,
  savePromptToFile,
} from '../../core/prompt-builder.js';
import {
  commitPhaseCompletion,
  createPhaseCheckpoint,
  getGitStatus,
} from '../../core/git-integration.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface RunOptions {
  phase?: string;
  dryRun?: boolean;
  auto?: boolean;
}

export async function runCommand(options: RunOptions): Promise<void> {
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
  
  if (state.phases.length === 0) {
    console.log(chalk.yellow('No phases defined. Run: ai-phases refine "your idea"'));
    process.exit(1);
  }
  
  // Determine which phase to run
  let phaseNumber: number;
  if (options.phase) {
    phaseNumber = parseInt(options.phase, 10);
  } else {
    phaseNumber = state.current_phase || 1;
  }
  
  const phase = state.phases.find(p => p.phase_number === phaseNumber);
  if (!phase) {
    console.log(chalk.red(`Phase ${phaseNumber} not found.`));
    console.log(chalk.dim(`Available phases: 1-${state.total_phases}`));
    process.exit(1);
  }
  
  // Check if phase is blocked
  if (phase.status === 'blocked') {
    console.log(chalk.red(`\n⛔ Phase ${phaseNumber} is BLOCKED after ${phase.max_attempts} failed attempts.`));
    console.log(chalk.dim('\nManual intervention required. See:'));
    console.log(chalk.cyan(`  ${path.join(getProjectPhasesDir(), 'phases', `phase-${phaseNumber}`, 'BLOCKED.md')}`));
    return;
  }
  
  // Check if phase is already completed
  if (phase.status === 'completed' && !options.auto) {
    const { rerun } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'rerun',
        message: `Phase ${phaseNumber} is already completed. Run again?`,
        default: false,
      },
    ]);
    
    if (!rerun) {
      console.log(chalk.dim('Skipped.'));
      return;
    }
  }
  
  // Load previous handover if exists
  let previousHandover: string | undefined;
  if (phaseNumber > 1) {
    const prevHandoverPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber - 1}`,
      'handover.md'
    );
    if (await fs.pathExists(prevHandoverPath)) {
      previousHandover = await fs.readFile(prevHandoverPath, 'utf-8');
    }
  }
  
  // Generate prompt
  const prompt = await generatePhaseExecutionPrompt(phase, previousHandover);
  
  // Display phase info
  console.log(
    boxen(
      chalk.bold.cyan(`📋 Phase ${phaseNumber}: ${phase.name}`) +
      '\n\n' +
      chalk.dim(`Attempt ${phase.current_attempt + 1} of ${phase.max_attempts}`) +
      '\n' +
      chalk.dim(`Model: ${prompt.modelName}`),
      {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'cyan',
      }
    )
  );
  
  console.log(chalk.white('\nDescription:'));
  console.log(chalk.dim(`  ${phase.description}\n`));
  
  console.log(chalk.white('Tasks:'));
  phase.tasks.forEach((task, i) => {
    const status = task.status === 'completed' ? chalk.green('✓') : chalk.dim('○');
    console.log(`  ${status} ${i + 1}. ${task.description}`);
  });
  console.log();
  
  if (prompt.context7Instructions && prompt.context7Instructions.length > 0) {
    console.log(chalk.white('Context7 Docs to Look Up:'));
    prompt.context7Instructions.forEach(q => {
      console.log(chalk.dim('  • ') + chalk.cyan(q));
    });
    console.log();
  }
  
  // Dry run - just show the prompt
  if (options.dryRun) {
    console.log(chalk.yellow('\n━━━ DRY RUN - Prompt Preview ━━━\n'));
    console.log(buildCursorPrompt(prompt));
    console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    return;
  }
  
  // Save prompt and create attempt
  const spinner = ora('Preparing phase...').start();
  
  try {
    // Create new attempt
    const attempt = await createNewAttempt(phaseNumber);
    
    // Save prompt to attempt directory
    const promptPath = await savePromptToFile(prompt, phaseNumber, attempt.attempt_number);
    
    // Copy to clipboard
    const fullPrompt = buildCursorPrompt(prompt);
    await copyToClipboard(fullPrompt);
    
    spinner.succeed('Phase prepared!');
    
    console.log(chalk.green('\n✓ Prompt saved: ') + chalk.dim(promptPath));
    console.log(chalk.green('✓ Prompt copied to clipboard!\n'));
    
    // Instructions
    console.log(chalk.yellow('┌────────────────────────────────────────────────────────────┐'));
    console.log(chalk.yellow('│ ') + chalk.white.bold('Action Required') + chalk.yellow('                                           │'));
    console.log(chalk.yellow('├────────────────────────────────────────────────────────────┤'));
    console.log(chalk.yellow('│ ') + chalk.white('1. Open Cursor in this project') + chalk.yellow('                            │'));
    console.log(chalk.yellow('│ ') + chalk.white('2. Switch to Agent mode (Cmd+Shift+I)') + chalk.yellow('                     │'));
    console.log(chalk.yellow('│ ') + chalk.white(`3. Select model: ${prompt.modelName.substring(0, 25).padEnd(25)}`) + chalk.yellow('        │'));
    console.log(chalk.yellow('│ ') + chalk.white('4. Paste the prompt (Cmd+V)') + chalk.yellow('                               │'));
    console.log(chalk.yellow('│ ') + chalk.white('5. Review and approve changes') + chalk.yellow('                             │'));
    console.log(chalk.yellow('└────────────────────────────────────────────────────────────┘\n'));
    
    // Wait for completion
    const { result } = await inquirer.prompt([
      {
        type: 'list',
        name: 'result',
        message: 'Phase execution result:',
        choices: [
          { name: '✓ Completed successfully', value: 'completed' },
          { name: '✗ Failed - will retry', value: 'failed' },
          { name: '⏸ Pause - continue later', value: 'pause' },
        ],
      },
    ]);
    
    if (result === 'completed') {
      await handlePhaseCompleted(phaseNumber, attempt.attempt_number, globalConfig);
    } else if (result === 'failed') {
      await handlePhaseFailed(phaseNumber, attempt.attempt_number, phase.max_attempts);
    } else {
      console.log(chalk.dim('\nPaused. Resume with:'));
      console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}\n`));
    }
    
  } catch (error) {
    spinner.fail('Failed to prepare phase');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  }
}

async function handlePhaseCompleted(
  phaseNumber: number,
  attemptNumber: number,
  globalConfig: any
): Promise<void> {
  const spinner = ora('Completing phase...').start();
  
  try {
    // Get modified files from git
    const gitStatus = await getGitStatus();
    const filesModified = [...gitStatus.modifiedFiles, ...gitStatus.untrackedFiles];
    
    // Mark attempt completed
    await markAttemptCompleted(phaseNumber, attemptNumber, filesModified);
    
    // Auto-commit if enabled
    if (globalConfig.defaults.auto_commit) {
      const phase = await loadPhaseState(phaseNumber);
      if (phase) {
        await commitPhaseCompletion(phaseNumber, phase.name, attemptNumber);
        await createPhaseCheckpoint(phaseNumber, attemptNumber);
      }
    }
    
    // Update current phase in state
    const state = await loadProjectState();
    if (state) {
      if (phaseNumber < state.total_phases) {
        state.current_phase = phaseNumber + 1;
      } else {
        state.status = 'completed';
      }
      await saveProjectState(state);
    }
    
    spinner.succeed('Phase completed!');
    
    console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green.bold(`  ✅ Phase ${phaseNumber} Complete!`));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    if (filesModified.length > 0) {
      console.log(chalk.dim('Files modified:'));
      filesModified.slice(0, 10).forEach(f => console.log(chalk.dim(`  • ${f}`)));
      if (filesModified.length > 10) {
        console.log(chalk.dim(`  ... and ${filesModified.length - 10} more`));
      }
      console.log();
    }
    
    // Prompt for handover
    const { createHandover } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'createHandover',
        message: 'Generate handover summary for next phase?',
        default: true,
      },
    ]);
    
    if (createHandover) {
      console.log(chalk.cyan('\nRun: ai-phases handover --phase ' + phaseNumber + '\n'));
    }
    
    // Show next steps
    if (state && state.status !== 'completed') {
      console.log(chalk.white('Next phase:'));
      console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber + 1}\n`));
    } else {
      console.log(chalk.green.bold('🎉 All phases complete! Project finished.\n'));
    }
    
  } catch (error) {
    spinner.fail('Failed to complete phase');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  }
}

async function handlePhaseFailed(
  phaseNumber: number,
  attemptNumber: number,
  maxAttempts: number
): Promise<void> {
  console.log(chalk.yellow('\n━━━ Failure Report ━━━\n'));
  
  const { errorSummary, suggestedFix } = await inquirer.prompt([
    {
      type: 'editor',
      name: 'errorSummary',
      message: 'What went wrong? (opens editor)',
      default: 'Describe the error or failure...',
    },
    {
      type: 'editor',
      name: 'suggestedFix',
      message: 'Suggested fix for next attempt? (opens editor)',
      default: 'What should be tried differently...',
    },
  ]);
  
  await markAttemptFailed(phaseNumber, attemptNumber, errorSummary, suggestedFix);
  
  const remainingAttempts = maxAttempts - attemptNumber;
  
  if (remainingAttempts > 0) {
    console.log(chalk.yellow(`\n⚠️  Attempt ${attemptNumber} failed. ${remainingAttempts} attempt(s) remaining.\n`));
    console.log(chalk.dim('Failure report saved. To retry:'));
    console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}\n`));
    console.log(chalk.dim('Or to rollback to before this phase:'));
    console.log(chalk.cyan(`  ai-phases rollback --phase ${phaseNumber}\n`));
  } else {
    console.log(chalk.red(`\n⛔ Phase ${phaseNumber} BLOCKED after ${maxAttempts} failed attempts.\n`));
    console.log(chalk.dim('Manual intervention required. See the BLOCKED.md file for details.'));
  }
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
    
    const child = await execAsync(`echo "${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" | ${command}`);
  } catch {
    // Silent fail
  }
}
