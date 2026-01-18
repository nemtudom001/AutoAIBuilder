import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
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
  pushToRemote,
  hasRemote,
} from '../../core/git-integration.js';
import {
  runCursorAgent,
  isCursorCliInstalled,
  isCursorCliAuthenticated,
} from '../../core/cursor-cli.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface RunOptions {
  phase?: string;
  dryRun?: boolean;
  auto?: boolean;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const isAutoMode = options.auto === true;
  
  // Helper to handle errors - throw in auto mode, exit in manual mode
  function handleError(message: string, hint?: string): never {
    console.log(chalk.red(message));
    if (hint) console.log(chalk.dim(hint));
    if (isAutoMode) {
      throw new Error(message);
    }
    process.exit(1);
  }
  
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig || !globalConfig.setup_complete) {
    return handleError('Please run setup first: ai-phases config --setup');
  }
  
  // Verify CLI setup
  const cliInstalled = await isCursorCliInstalled();
  if (!cliInstalled) {
    return handleError(
      '\n✗ cursor-agent CLI not found.',
      'Install with: curl https://cursor.com/install -fsS | bash\n'
    );
  }
  
  const isAuthenticated = await isCursorCliAuthenticated();
  if (!isAuthenticated) {
    return handleError(
      '\n✗ Not logged in to Cursor CLI.',
      'Run: cursor-agent login\n'
    );
  }
  
  const state = await loadProjectState();
  if (!state) {
    return handleError('Project not initialized. Run: ai-phases init');
  }
  
  if (state.phases.length === 0) {
    return handleError('No phases defined. Run: ai-phases refine "your idea"');
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
    return handleError(
      `Phase ${phaseNumber} not found.`,
      `Available phases: ${state.phases.map(p => p.phase_number).join(', ')}`
    );
  }
  
  // Check if phase is blocked
  if (phase.status === 'blocked') {
    console.log(chalk.red(`\n⛔ Phase ${phaseNumber} is BLOCKED after ${phase.max_attempts} failed attempts.`));
    console.log(chalk.dim('\nManual intervention required. See:'));
    console.log(chalk.cyan(`  ${path.join(getProjectPhasesDir(), 'phases', `phase-${phaseNumber}`, 'BLOCKED.md')}`));
    if (isAutoMode) throw new Error(`Phase ${phaseNumber} is blocked`);
    return;
  }
  
  // Check if phase is already completed
  if (phase.status === 'completed' && !options.auto) {
    console.log(chalk.yellow(`\n⚠️  Phase ${phaseNumber} is already completed.`));
    console.log(chalk.dim('Use --auto to force re-run, or continue to next phase:\n'));
    console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber + 1}\n`));
    return;
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
  
  // Dry run - just show the prompt
  if (options.dryRun) {
    console.log(chalk.yellow('\n━━━ DRY RUN - Prompt Preview ━━━\n'));
    console.log(buildCursorPrompt(prompt));
    console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    return;
  }
  
  // Create new attempt
  const attempt = await createNewAttempt(phaseNumber);
  
  // Save prompt to attempt directory
  const promptPath = await savePromptToFile(prompt, phaseNumber, attempt.attempt_number);
  console.log(chalk.dim('Prompt saved: ') + chalk.white(promptPath));
  
  // Execute phase via cursor-agent
  console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow.bold('  🚀 Executing Phase via Cursor CLI'));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  
  const spinner = ora({
    text: `Running phase ${phaseNumber} with ${prompt.modelName}...`,
    spinner: 'dots12',
  }).start();
  
  const startTime = Date.now();
  const fullPrompt = buildCursorPrompt(prompt);
  
  const result = await runCursorAgent({
    prompt: fullPrompt,
    model: prompt.modelName,
    workingDir: process.cwd(),
    timeout: 600000, // 10 minutes
    onOutput: (chunk) => {
      // Update spinner with progress
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const lines = chunk.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1].substring(0, 50);
        spinner.text = `Running phase ${phaseNumber} (${elapsed}s) ${chalk.dim(lastLine + '...')}`;
      }
    },
  });
  
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  
  if (result.success) {
    spinner.succeed(`Phase ${phaseNumber} completed in ${elapsed}s`);
    await handlePhaseCompleted(phaseNumber, attempt.attempt_number, globalConfig, result);
  } else {
    spinner.fail(`Phase ${phaseNumber} failed after ${elapsed}s`);
    await handlePhaseFailed(phaseNumber, attempt.attempt_number, phase.max_attempts, result.error || 'Unknown error');
  }
}

async function handlePhaseCompleted(
  phaseNumber: number,
  attemptNumber: number,
  globalConfig: any,
  result: { output: string; filesModified?: string[] }
): Promise<void> {
  const spinner = ora('Completing phase...').start();
  
  try {
    // Load phase to get validation commands
    const phase = await loadPhaseState(phaseNumber);
    
    // Get modified files from git (more reliable than parsing output)
    const gitStatus = await getGitStatus();
    
    // Filter to only files within this project directory
    const allFiles = [...gitStatus.modifiedFiles, ...gitStatus.untrackedFiles];
    const filesModified = allFiles.filter(f => {
      // Exclude files from parent directories (e.g., if project is nested in another repo)
      // Also exclude .ai-phases internal files from display
      return !f.startsWith('..') && 
             !f.includes('/.ai-phases/') &&
             !f.startsWith('.ai-phases/');
    });
    
    // Run validation commands if any exist
    if (phase?.validation_commands && phase.validation_commands.length > 0) {
      spinner.text = 'Running validation checks...';
      const validationResult = await runValidationCommands(phase.validation_commands);
      
      if (!validationResult.success) {
        spinner.fail('Validation failed');
        console.log(chalk.red('\n━━━ Validation Failed ━━━\n'));
        console.log(chalk.dim('Failed commands:'));
        validationResult.failures.forEach(f => {
          console.log(chalk.red(`  ✗ ${f.command}`));
          if (f.error) {
            console.log(chalk.dim(`    ${f.error.split('\n')[0]}`));
          }
        });
        
        // Mark as failed due to validation
        await markAttemptFailed(
          phaseNumber,
          attemptNumber,
          `Validation commands failed:\n${validationResult.failures.map(f => `- ${f.command}: ${f.error}`).join('\n')}`,
          'Fix the validation errors and retry'
        );
        
        const remainingAttempts = (phase?.max_attempts || 3) - attemptNumber;
        if (remainingAttempts > 0) {
          console.log(chalk.yellow(`\n⚠️  ${remainingAttempts} attempt(s) remaining. Retry with:`));
          console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}\n`));
        }
        return;
      }
      
      spinner.text = 'Validation passed, completing phase...';
    }
    
    // Mark attempt completed
    await markAttemptCompleted(phaseNumber, attemptNumber, filesModified);
    
    // Save agent output
    const outputPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      `attempt-${attemptNumber}`,
      'output.md'
    );
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, result.output);
    
    // Auto-commit if enabled
    if (globalConfig.defaults.auto_commit) {
      const phase = await loadPhaseState(phaseNumber);
      if (phase) {
        await commitPhaseCompletion(phaseNumber, phase.name, attemptNumber);
        await createPhaseCheckpoint(phaseNumber, attemptNumber);
        
        // Auto-push if enabled and remote exists
        if (globalConfig.defaults.auto_push && await hasRemote()) {
          const pushResult = await pushToRemote();
          if (!pushResult.success && pushResult.error) {
            console.log(chalk.yellow(`⚠️  Push failed: ${pushResult.error}`));
          }
        }
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
    
    // Generate handover automatically
    console.log(chalk.dim('Generating handover summary...'));
    await generateAutoHandover(phaseNumber, result.output, filesModified);
    
    // Show next steps
    if (state && state.status !== 'completed') {
      console.log(chalk.white('\nNext phase:'));
      console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber + 1}\n`));
    } else {
      console.log(chalk.green.bold('\n🎉 All phases complete! Project finished.\n'));
    }
    
  } catch (error) {
    spinner.fail('Failed to complete phase');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  }
}

async function handlePhaseFailed(
  phaseNumber: number,
  attemptNumber: number,
  maxAttempts: number,
  errorMessage: string
): Promise<void> {
  console.log(chalk.red('\n━━━ Phase Failed ━━━\n'));
  console.log(chalk.dim('Error: ') + chalk.red(errorMessage));
  
  // Save error report
  const errorPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'error.md'
  );
  await fs.ensureDir(path.dirname(errorPath));
  await fs.writeFile(errorPath, `# Phase ${phaseNumber} - Attempt ${attemptNumber} Error\n\n${errorMessage}`);
  
  // Mark attempt failed
  await markAttemptFailed(
    phaseNumber,
    attemptNumber,
    errorMessage,
    'Review error and retry with: ai-phases run --phase ' + phaseNumber
  );
  
  const remainingAttempts = maxAttempts - attemptNumber;
  
  if (remainingAttempts > 0) {
    console.log(chalk.yellow(`\n⚠️  Attempt ${attemptNumber} failed. ${remainingAttempts} attempt(s) remaining.\n`));
    console.log(chalk.dim('Error report saved. To retry:'));
    console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}\n`));
    console.log(chalk.dim('Or to rollback to before this phase:'));
    console.log(chalk.cyan(`  ai-phases rollback --phase ${phaseNumber}\n`));
  } else {
    // Create BLOCKED.md
    const blockedPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      'BLOCKED.md'
    );
    await fs.writeFile(blockedPath, `# Phase ${phaseNumber} BLOCKED

This phase has failed ${maxAttempts} times and requires manual intervention.

## Last Error
${errorMessage}

## Resolution Steps
1. Review the error above and attempt outputs in \`attempt-*/\` folders
2. Fix the underlying issue manually
3. Run \`ai-phases rollback --phase ${phaseNumber}\` to reset
4. Then \`ai-phases run --phase ${phaseNumber}\` to retry
`);
    
    console.log(chalk.red(`\n⛔ Phase ${phaseNumber} BLOCKED after ${maxAttempts} failed attempts.\n`));
    console.log(chalk.dim('Manual intervention required. See:'));
    console.log(chalk.cyan(`  ${blockedPath}\n`));
  }
}

/**
 * Auto-generate a handover summary from the phase output
 */
async function generateAutoHandover(
  phaseNumber: number,
  output: string,
  filesModified: string[]
): Promise<void> {
  const { runPlanningTask, extractMarkdown } = await import('../../core/cursor-cli.js');
  
  const handoverPrompt = `Based on the following phase completion output, generate a concise handover summary for the next phase.

## Phase ${phaseNumber} Output
${output.substring(0, 4000)}${output.length > 4000 ? '\n...(truncated)' : ''}

## Files Modified
${filesModified.map(f => `- ${f}`).join('\n')}

Generate a handover in this format:

# Handover - Phase ${phaseNumber}

## Completed Work
- [Brief bullet points]

## Key Files
| File | Purpose |
|------|---------|
| file | what it does |

## Context for Next Phase
- [Important information for the next developer/AI]

Keep it concise (under 500 words). Focus on what the next phase needs to know.`;

  try {
    const result = await runPlanningTask(handoverPrompt);
    
    if (result.success) {
      const handoverContent = extractMarkdown(result.output);
      const handoverPath = path.join(
        getProjectPhasesDir(),
        'phases',
        `phase-${phaseNumber}`,
        'handover.md'
      );
      await fs.writeFile(handoverPath, handoverContent);
      console.log(chalk.green('✓ Handover generated: ') + chalk.dim(handoverPath));
    }
  } catch {
    // Handover generation is optional, don't fail the phase
    console.log(chalk.dim('Handover generation skipped (optional)'));
  }
}

interface ValidationResult {
  success: boolean;
  failures: Array<{ command: string; error?: string }>;
  passed: string[];
}

/**
 * Run validation commands to verify phase completion
 */
async function runValidationCommands(commands: string[]): Promise<ValidationResult> {
  const result: ValidationResult = {
    success: true,
    failures: [],
    passed: [],
  };
  
  for (const command of commands) {
    try {
      // Run command with a reasonable timeout (60 seconds)
      await execAsync(command, {
        cwd: process.cwd(),
        timeout: 60000,
        env: { ...process.env, CI: 'true' }, // Some tools behave better in CI mode
      });
      result.passed.push(command);
    } catch (error: any) {
      result.success = false;
      result.failures.push({
        command,
        error: error.stderr || error.stdout || error.message || 'Unknown error',
      });
    }
  }
  
  return result;
}
