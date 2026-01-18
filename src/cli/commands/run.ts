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
  generateErrorFixPrompt,
  buildCursorPrompt,
  savePromptToFile,
} from '../../core/prompt-builder.js';
import {
  commitPhaseCompletion,
  commitPartialProgress,
  createPhaseCheckpoint,
  getGitStatus,
  pushToRemote,
  hasRemote,
} from '../../core/git-integration.js';
import {
  runPreflightChecks,
  displayPreflightResults,
} from '../../core/preflight-checks.js';
import {
  attemptAutoFix,
  displayAutoFixResults,
} from '../../core/auto-fix.js';
import {
  runCursorAgent,
  isCursorCliInstalled,
  getInstallInstructions,
} from '../../core/cursor-cli.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Maximum number of AI fix attempts per validation failure
const MAX_AI_FIX_ATTEMPTS = 2;

interface RunOptions {
  phase?: string;
  dryRun?: boolean;
  auto?: boolean;
  isRetry?: boolean; // Internal flag for retry attempts
  errorContext?: string; // Error context from previous attempt
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
    console.log(chalk.red('\n✗ Cursor CLI (agent) not found.\n'));
    console.log(chalk.dim(getInstallInstructions()));
    console.log();
    if (isAutoMode) throw new Error('Cursor CLI not installed');
    process.exit(1);
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
  
  // Run pre-flight checks for phases after Phase 1
  if (phaseNumber > 1) {
    const preflightResult = await runPreflightChecks(phaseNumber, globalConfig.defaults.ui_library);
    displayPreflightResults(preflightResult);
    
    if (!preflightResult.passed) {
      console.log(chalk.red('\n⛔ Pre-flight checks failed. Fix the issues above before running this phase.\n'));
      if (isAutoMode) {
        throw new Error('Pre-flight checks failed');
      }
      process.exit(1);
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
  
  // Generate prompt with error context if this is a retry
  const errorContext = options.isRetry ? options.errorContext : undefined;
  const prompt = await generatePhaseExecutionPrompt(phase, previousHandover, errorContext);
  
  // Log retry context if applicable
  if (options.isRetry) {
    console.log(chalk.yellow('\n🔄 RETRY MODE: Starting fresh AI context with error information from previous attempt.\n'));
  }
  
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
    const completionResult = await handlePhaseCompleted(phaseNumber, attempt.attempt_number, globalConfig, result);
    
    if (completionResult.success) {
      // Auto-continue to next phase if enabled
      if (globalConfig.defaults.auto_run_phases) {
        const updatedState = await loadProjectState();
        if (updatedState && updatedState.status !== 'completed') {
          const nextPhase = updatedState.phases.find(p => p.status === 'pending');
          if (nextPhase) {
            console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            console.log(chalk.cyan.bold('  ▶ STARTING NEW PHASE WITH FRESH CONTEXT'));
            console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            console.log(chalk.dim('\n  Previous phase context cleared. Using handover notes only.\n'));
            console.log(chalk.cyan(`  → Phase ${nextPhase.phase_number}: ${nextPhase.name}\n`));
            
            // Start next phase with fresh context (new cursor-agent invocation)
            // The handover from the previous phase is loaded in generatePhaseExecutionPrompt
            await runCommand({ phase: String(nextPhase.phase_number), auto: isAutoMode });
          }
        }
      }
    } else if (completionResult.needsRetry && completionResult.errorContext) {
      // Validation failed - attempt AI-driven fix with fresh context
      const remainingAttempts = phase.max_attempts - attempt.attempt_number;
      if (remainingAttempts > 0 && isAutoMode) {
        console.log(chalk.yellow(`\n🔧 Retrying with fresh AI context (${remainingAttempts} attempts remaining)...\n`));
        console.log(chalk.dim('  Previous context cleared. Error information will be passed to new session.\n'));
        
        // Note: Partial progress already committed in handlePhaseCompleted
        // Retry with error context passed to new AI context window
        await runCommand({ 
          phase: String(phaseNumber), 
          auto: true, 
          isRetry: true,
          errorContext: completionResult.errorContext 
        });
      } else if (remainingAttempts > 0) {
        console.log(chalk.yellow(`\n⚠️  ${remainingAttempts} attempt(s) remaining. Retry with:`));
        console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}\n`));
      } else {
        console.log(chalk.red(`\n⛔ Phase ${phaseNumber} BLOCKED - all ${phase.max_attempts} attempts exhausted.\n`));
        console.log(chalk.dim('Manual intervention required. Review the failure reports in:'));
        console.log(chalk.cyan(`  ${path.join(getProjectPhasesDir(), 'phases', `phase-${phaseNumber}`)}\n`));
      }
    }
  } else {
    spinner.fail(`Phase ${phaseNumber} failed after ${elapsed}s`);
    
    // Even on failure, commit any partial progress made
    const gitStatus = await getGitStatus();
    if (gitStatus.hasChanges) {
      console.log(chalk.dim('Committing partial progress before marking failed...'));
      await commitPartialProgress(phaseNumber, attempt.attempt_number, 'failed-execution');
    }
    
    await handlePhaseFailed(phaseNumber, attempt.attempt_number, phase.max_attempts, result.error || 'Unknown error');
    
    // If in auto mode and we have retries left, try again with fresh context
    // Reload phase to check if it was blocked by handlePhaseFailed
    const updatedPhase = await loadPhaseState(phaseNumber);
    if (updatedPhase && updatedPhase.status !== 'blocked') {
      const remainingAttempts = phase.max_attempts - attempt.attempt_number;
      if (remainingAttempts > 0 && isAutoMode) {
        console.log(chalk.yellow(`\n🔧 Auto-mode: Retrying with fresh AI context...\n`));
        console.log(chalk.dim('  Previous context cleared. Error information will inform new session.\n'));
        await runCommand({ 
          phase: String(phaseNumber), 
          auto: true, 
          isRetry: true,
          errorContext: result.error || 'Unknown execution error' 
        });
      }
    }
  }
}

interface PhaseCompletionResult {
  success: boolean;
  needsRetry?: boolean;
  errorContext?: string;
}

async function handlePhaseCompleted(
  phaseNumber: number,
  attemptNumber: number,
  globalConfig: any,
  result: { output: string; filesModified?: string[] }
): Promise<PhaseCompletionResult> {
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
      let validationResult = await runValidationCommands(phase.validation_commands);
      let aiFixAttempts = 0;
      
      // Keep trying to fix until validation passes or we run out of attempts
      while (!validationResult.success && aiFixAttempts < MAX_AI_FIX_ATTEMPTS) {
        aiFixAttempts++;
        spinner.warn(`Validation failed - attempting fix (${aiFixAttempts}/${MAX_AI_FIX_ATTEMPTS})...`);
        
        // Attempt basic auto-fix first (npm installs, etc.)
        const errorOutput = validationResult.failures.map(f => f.error || '').join('\n');
        const autoFixResult = await attemptAutoFix(errorOutput);
        
        if (autoFixResult.fixed) {
          displayAutoFixResults(autoFixResult);
          console.log(chalk.cyan('\n  Re-running validation after auto-fixes...\n'));
          validationResult = await runValidationCommands(phase.validation_commands);
          
          if (validationResult.success) {
            console.log(chalk.green('✓ Validation passed after auto-fixes!'));
            break;
          }
        }
        
        // If basic auto-fix didn't work, try AI-driven fix
        if (!validationResult.success) {
          spinner.text = 'Basic fix failed - requesting AI-driven fix...';
          
          // Build detailed error context for AI
          const errorDetails = validationResult.failures.map(f => {
            const errorLines = (f.error || '').split('\n').slice(0, 20).join('\n');
            return `Command: ${f.command}\nError:\n${errorLines}`;
          }).join('\n\n');
          
          // Generate AI fix prompt
          const fixPrompt = await generateErrorFixPrompt(
            phase,
            errorDetails,
            autoFixResult.suggestions,
            filesModified
          );
          
          // Run AI fix in fresh context
          console.log(chalk.yellow('\n━━━ AI Error Fix Attempt ━━━\n'));
          console.log(chalk.dim('Asking AI to analyze and fix the errors...\n'));
          
          const fixResult = await runCursorAgent({
            prompt: buildCursorPrompt(fixPrompt),
            model: fixPrompt.modelName,
            workingDir: process.cwd(),
            timeout: 300000, // 5 minutes for fix
            onOutput: (chunk) => {
              const lines = chunk.split('\n').filter(l => l.trim());
              if (lines.length > 0) {
                const lastLine = lines[lines.length - 1].substring(0, 50);
                spinner.text = `AI fixing: ${chalk.dim(lastLine)}...`;
              }
            },
          });
          
          if (fixResult.success) {
            console.log(chalk.green('✓ AI fix completed, re-validating...\n'));
            validationResult = await runValidationCommands(phase.validation_commands);
          } else {
            console.log(chalk.red(`✗ AI fix failed: ${fixResult.error || 'Unknown error'}`));
          }
        }
      }
      
      // Final check - if still failing after all attempts
      if (!validationResult.success) {
        spinner.fail('Validation failed after all fix attempts');
        console.log(chalk.red('\n━━━ Validation Failed ━━━\n'));
        console.log(chalk.dim('Failed commands:'));
        validationResult.failures.forEach(f => {
          console.log(chalk.red(`  ✗ ${f.command}`));
          if (f.error) {
            console.log(chalk.dim(`    ${f.error.split('\n')[0]}`));
          }
        });
        
        // Build error context for potential retry at phase level
        const errorDetails = validationResult.failures.map(f => 
          `- ${f.command}:\n${(f.error || 'Unknown error').split('\n').slice(0, 10).join('\n')}`
        ).join('\n\n');
        
        // Commit partial progress even on failure
        await commitPartialProgress(phaseNumber, attemptNumber, 'validation-failed');
        
        // Mark as failed with detailed error context
        await markAttemptFailed(
          phaseNumber,
          attemptNumber,
          `Validation commands failed after ${aiFixAttempts} fix attempts:\n${errorDetails}`,
          `AI could not automatically fix these errors. Manual intervention may be required.`
        );
        
        return {
          success: false,
          needsRetry: true,
          errorContext: errorDetails,
        };
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
    
    return { success: true };
    
  } catch (error) {
    spinner.fail('Failed to complete phase');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    return { 
      success: false, 
      needsRetry: true, 
      errorContext: error instanceof Error ? error.message : 'Unknown error' 
    };
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

// On Windows, run commands through WSL Ubuntu
const isWindows = process.platform === 'win32';

/**
 * Convert Windows path to WSL path (C:\Users\... -> /mnt/c/Users/...)
 */
function toWslPath(windowsPath: string): string {
  if (!isWindows) return windowsPath;
  return windowsPath
    .replace(/^([A-Z]):/i, (_, letter) => `/mnt/${letter.toLowerCase()}`)
    .replace(/\\/g, '/');
}

/**
 * Find the actual project directory (where package.json is)
 * Looks in current directory and common subdirectories
 */
async function findProjectDir(): Promise<string> {
  const cwd = process.cwd();
  
  // Check current directory first
  if (await fs.pathExists(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  
  // Check common subdirectories where AI might create projects
  const possibleDirs = ['web', 'app', 'frontend', 'client', 'src', 'project'];
  for (const dir of possibleDirs) {
    const fullPath = path.join(cwd, dir);
    if (await fs.pathExists(path.join(fullPath, 'package.json'))) {
      return fullPath;
    }
  }
  
  // Check any directory that has package.json
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const fullPath = path.join(cwd, entry.name);
        if (await fs.pathExists(path.join(fullPath, 'package.json'))) {
          return fullPath;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  
  return cwd;
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
  
  // Find the actual project directory
  const projectDir = await findProjectDir();
  
  for (const command of commands) {
    try {
      let actualCommand = command;
      let execOptions: any = {
        cwd: projectDir,
        timeout: 120000, // 2 minute timeout for builds
        env: { ...process.env, CI: 'true' },
      };
      
      // Skip long-running server commands - they're not suitable for validation
      if (command === 'npm run dev' || command === 'npm start' || command === 'yarn dev' || command === 'pnpm dev') {
        // Instead of running the dev server, just check package.json has the script
        const packageJsonPath = path.join(projectDir, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
          const packageJson = await fs.readJson(packageJsonPath);
          if (packageJson.scripts && packageJson.scripts.dev) {
            result.passed.push(command + ' (script exists)');
            continue;
          }
        }
        result.failures.push({ command, error: 'Dev script not found in package.json' });
        result.success = false;
        continue;
      }
      
      // Handle ls commands for common directories that might be in different locations
      if (command.startsWith('ls ') && command.includes('components/ui')) {
        // Try multiple common paths for components/ui
        const possiblePaths = [
          path.join(projectDir, 'components', 'ui'),
          path.join(projectDir, 'src', 'components', 'ui'),
          path.join(projectDir, 'app', 'components', 'ui'),
        ];
        let found = false;
        for (const uiPath of possiblePaths) {
          if (await fs.pathExists(uiPath)) {
            const files = await fs.readdir(uiPath);
            if (files.length > 0) {
              result.passed.push(command + ` (found ${files.length} files in ${uiPath})`);
              found = true;
              break;
            }
          }
        }
        if (!found) {
          result.failures.push({ command, error: 'components/ui directory not found in any common location' });
          result.success = false;
        }
        continue;
      }
      
      // On Windows, run commands through WSL for consistency
      if (isWindows) {
        const wslProjectDir = toWslPath(projectDir);
        
        // Convert Unix commands to run through WSL
        if (command.startsWith('ls ') || command === 'ls') {
          actualCommand = `wsl -d Ubuntu -e bash -c "cd '${wslProjectDir}' && ${command}"`;
          execOptions.cwd = undefined;
        } else if (command.startsWith('npm ') || command.startsWith('npx ') || command.startsWith('yarn ') || command.startsWith('pnpm ')) {
          // Run npm/npx commands through WSL for consistency with how AI ran them
          actualCommand = `wsl -d Ubuntu -e bash -c "cd '${wslProjectDir}' && ${command}"`;
          execOptions.cwd = undefined; // WSL handles the cwd
        }
      }
      
      await execAsync(actualCommand, execOptions);
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
