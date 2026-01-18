import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { loadGlobalConfig, getProjectPhasesDir } from '../../core/config-manager.js';
import {
  loadProjectState,
  saveProjectState,
  loadPhaseState,
  updatePhaseState,
  createNewAttempt,
  markAttemptCompleted,
  markAttemptFailed,
  loadAttemptState,
} from '../../core/state-manager.js';
import {
  generatePhaseExecutionPrompt,
  generateErrorFixPrompt,
  generateDeepAnalysisPrompt,
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
import {
  performSelfReview,
  displaySelfReviewResults,
  saveSelfReviewResults,
} from '../../core/self-review.js';
import {
  analyzeDependencies,
  preInstallDependencies,
  displayDependencyCheck,
} from '../../core/dependency-check.js';
import {
  createCheckpoint,
  getCheckpoints,
  getCheckpointRecoveryInfo,
} from '../../core/checkpoint.js';
import {
  findMatchingFix,
  recordSuccessfulFix,
  applyKnownFix,
} from '../../core/error-memory.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Maximum number of AI fix attempts per validation failure
const MAX_AI_FIX_ATTEMPTS = 2;

// Default max attempts before asking user
const DEFAULT_MAX_ATTEMPTS = 3;

interface RunOptions {
  phase?: string;
  dryRun?: boolean;
  auto?: boolean;
  isRetry?: boolean; // Internal flag for retry attempts
  errorContext?: string; // Error context from previous attempt
  consecutiveErrors?: number; // Track consecutive errors for enhanced context
  modelOverride?: string; // Allow model override for retries
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
  
  // Check if this is the last phase
  const isLastPhase = phaseNumber === state.total_phases;
  
  // Generate prompt with error context and options
  const errorContext = options.isRetry ? options.errorContext : undefined;
  const consecutiveErrors = options.consecutiveErrors || 0;
  const prompt = await generatePhaseExecutionPrompt(phase, previousHandover, errorContext, {
    consecutiveErrors,
    modelOverride: options.modelOverride,
    isLastPhase,
  });
  
  // Log retry context if applicable
  if (options.isRetry) {
    if (consecutiveErrors >= 2) {
      console.log(chalk.yellow('\n🔍 ENHANCED ANALYSIS MODE: Multiple errors detected. Loading comprehensive context...\n'));
    } else {
      console.log(chalk.yellow('\n🔄 RETRY MODE: Starting fresh AI context with error information from previous attempt.\n'));
    }
  }
  
  // Log if using different model
  if (options.modelOverride) {
    console.log(chalk.cyan(`📊 Using model override: ${options.modelOverride}\n`));
  } else if (isLastPhase) {
    console.log(chalk.cyan('🎯 FINAL PHASE: Using Opus model for quality and polish\n'));
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
  
  // === DEPENDENCY PRE-CHECK ===
  // Analyze and pre-install dependencies before execution to prevent common errors
  console.log(chalk.cyan('\n━━━ Pre-Execution Dependency Check ━━━\n'));
  const depCheckResult = await analyzeDependencies(phase);
  displayDependencyCheck(depCheckResult);
  
  if (depCheckResult.missingDependencies.length > 0 || depCheckResult.missingShadcnComponents.length > 0) {
    const { installed, failed } = await preInstallDependencies(depCheckResult);
    if (installed.length > 0) {
      console.log(chalk.green(`✓ Pre-installed ${installed.length} dependencies to prevent errors\n`));
    }
    if (failed.length > 0) {
      console.log(chalk.yellow(`⚠ ${failed.length} dependencies could not be pre-installed (AI will handle)\n`));
    }
  }
  
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
        // All attempts exhausted - prompt user for options
        await handleMaxAttemptsReached(phaseNumber, phase, completionResult.errorContext || '');
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
    
    // Write detailed error report
    await writeDetailedErrorReport(phaseNumber, attempt.attempt_number, result.error || 'Unknown error', result.output);
    
    await handlePhaseFailed(phaseNumber, attempt.attempt_number, phase.max_attempts, result.error || 'Unknown error');
    
    // Track consecutive errors
    const consecutiveErrors = (options.consecutiveErrors || 0) + 1;
    
    // If in auto mode and we have retries left, try again with fresh context
    // Reload phase to check if it was blocked by handlePhaseFailed
    const updatedPhase = await loadPhaseState(phaseNumber);
    if (updatedPhase && updatedPhase.status !== 'blocked') {
      const remainingAttempts = phase.max_attempts - attempt.attempt_number;
      if (remainingAttempts > 0 && isAutoMode) {
        // On third consecutive error, use enhanced context
        if (consecutiveErrors >= 2) {
          console.log(chalk.yellow(`\n🔍 Multiple consecutive errors detected - using enhanced analysis...\n`));
        } else {
          console.log(chalk.yellow(`\n🔧 Auto-mode: Retrying with fresh AI context...\n`));
        }
        console.log(chalk.dim('  Previous context cleared. Error information will inform new session.\n'));
        await runCommand({ 
          phase: String(phaseNumber), 
          auto: true, 
          isRetry: true,
          errorContext: result.error || 'Unknown execution error',
          consecutiveErrors,
        });
      }
    } else if (updatedPhase?.status === 'blocked') {
      // All attempts exhausted - prompt user for options
      await handleMaxAttemptsReached(phaseNumber, phase, result.error || 'Unknown error');
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
    
    // === SELF-REVIEW BEFORE VALIDATION ===
    // AI reviews its own work to catch obvious mistakes before running validation
    spinner.text = 'Running AI self-review...';
    const selfReviewResult = await performSelfReview(phase!, filesModified, result.output);
    await saveSelfReviewResults(phaseNumber, attemptNumber, selfReviewResult);
    
    if (!selfReviewResult.passed) {
      spinner.warn('Self-review found issues');
      displaySelfReviewResults(selfReviewResult);
      
      // If there are critical issues, try to fix them before validation
      const criticalIssues = selfReviewResult.issues.filter(i => i.severity === 'critical');
      if (criticalIssues.length > 0) {
        console.log(chalk.yellow('\n  Attempting to fix critical issues found in self-review...\n'));
        // The AI will fix these in the validation fix loop
      }
    } else {
      spinner.text = 'Self-review passed ✓';
    }
    
    // === CREATE CHECKPOINT ===
    // Save progress at this point in case validation fails
    await createCheckpoint(
      phaseNumber,
      attemptNumber,
      phase?.tasks.length || 0,
      'Pre-validation checkpoint',
      filesModified
    );
    
    // Run validation commands if any exist
    if (phase?.validation_commands && phase.validation_commands.length > 0) {
      spinner.text = 'Running validation checks...';
      let validationResult = await runValidationCommands(phase.validation_commands);
      let aiFixAttempts = 0;
      
      // Keep trying to fix until validation passes or we run out of attempts
      while (!validationResult.success && aiFixAttempts < MAX_AI_FIX_ATTEMPTS) {
        aiFixAttempts++;
        spinner.warn(`Validation failed - attempting fix (${aiFixAttempts}/${MAX_AI_FIX_ATTEMPTS})...`);
        
        // === CHECK ERROR MEMORY FIRST ===
        // Look for known fixes before trying generic auto-fix
        const errorOutput = validationResult.failures.map(f => f.error || '').join('\n');
        const knownFix = await findMatchingFix(errorOutput);
        
        if (knownFix) {
          console.log(chalk.cyan(`\n  💡 Found known fix in error memory: ${knownFix.fixType}`));
          const applied = await applyKnownFix(knownFix);
          if (applied) {
            console.log(chalk.green('  ✓ Applied known fix, re-validating...\n'));
            validationResult = await runValidationCommands(phase.validation_commands);
            if (validationResult.success) {
              // Record success to increase confidence
              await recordSuccessfulFix(errorOutput, knownFix.fix, knownFix.fixType);
              console.log(chalk.green('✓ Validation passed using known fix!'));
              break;
            }
          }
        }
        
        // Attempt basic auto-fix (npm installs, etc.)
        const autoFixResult = await attemptAutoFix(errorOutput);
        
        if (autoFixResult.fixed) {
          displayAutoFixResults(autoFixResult);
          console.log(chalk.cyan('\n  Re-running validation after auto-fixes...\n'));
          validationResult = await runValidationCommands(phase.validation_commands);
          
          if (validationResult.success) {
            // === RECORD SUCCESSFUL FIX IN ERROR MEMORY ===
            for (const fix of autoFixResult.fixesApplied) {
              await recordSuccessfulFix(
                errorOutput,
                fix,
                fix.includes('npm install') ? 'npm_install' : 
                fix.includes('shadcn') ? 'shadcn_add' : 'code_change'
              );
            }
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
            const prevValidationResult = validationResult;
            validationResult = await runValidationCommands(phase.validation_commands);
            
            // If AI fix worked, record it in error memory
            if (validationResult.success) {
              await recordSuccessfulFix(
                errorDetails,
                'AI-driven code fix',
                'code_change',
                `Fixed during phase ${phaseNumber} attempt ${attemptNumber}`
              );
            }
          } else {
            console.log(chalk.red(`✗ AI fix failed: ${fixResult.error || 'Unknown error'}`));
          }
        }
      }
      
      // Final check - if still failing after all attempts
      if (!validationResult.success) {
        // Include checkpoint recovery info in the error context
        const checkpointInfo = await getCheckpointRecoveryInfo(phaseNumber, attemptNumber);
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
        
        // Show checkpoint recovery info
        if (checkpointInfo && !checkpointInfo.includes('No checkpoints')) {
          console.log(chalk.cyan('\n📍 Checkpoint Recovery Available:'));
          console.log(chalk.dim(checkpointInfo.split('\n').slice(0, 5).join('\n')));
        }
        
        // Commit partial progress even on failure
        await commitPartialProgress(phaseNumber, attemptNumber, 'validation-failed');
        
        // Mark as failed with detailed error context including checkpoint info
        await markAttemptFailed(
          phaseNumber,
          attemptNumber,
          `Validation commands failed after ${aiFixAttempts} fix attempts:\n${errorDetails}\n\n${checkpointInfo}`,
          `AI could not automatically fix these errors. Manual intervention may be required.`
        );
        
        return {
          success: false,
          needsRetry: true,
          errorContext: `${errorDetails}\n\n${checkpointInfo}`,
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
 * Write a detailed error report to help AI analyze and fix issues
 */
async function writeDetailedErrorReport(
  phaseNumber: number,
  attemptNumber: number,
  errorMessage: string,
  fullOutput: string
): Promise<void> {
  const phase = await loadPhaseState(phaseNumber);
  const phasesDir = getProjectPhasesDir();
  
  // Collect all previous attempt errors for pattern analysis
  const previousErrors: string[] = [];
  for (let i = 1; i < attemptNumber; i++) {
    const prevAttempt = await loadAttemptState(phaseNumber, i);
    if (prevAttempt?.error_summary) {
      previousErrors.push(`Attempt ${i}: ${prevAttempt.error_summary}`);
    }
  }
  
  // Get git diff to show what changed
  let gitDiff = '';
  try {
    const { stdout } = await execAsync('git diff HEAD~1 --stat', { cwd: process.cwd() });
    gitDiff = stdout;
  } catch {
    gitDiff = 'Unable to get git diff';
  }
  
  const errorReportPath = path.join(
    phasesDir,
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'detailed-error-report.md'
  );
  
  const report = `# Detailed Error Report - Phase ${phaseNumber}, Attempt ${attemptNumber}

## Error Summary
${errorMessage}

## Phase Context
- **Phase Name**: ${phase?.name || 'Unknown'}
- **Phase Description**: ${phase?.description || 'Unknown'}
- **Attempt Number**: ${attemptNumber} of ${phase?.max_attempts || 3}

## Tasks Being Attempted
${phase?.tasks.map((t, i) => `${i + 1}. ${t.description} (${t.status})`).join('\n') || 'Unknown'}

## Validation Commands That Should Pass
${phase?.validation_commands?.map(c => `- \`${c}\``).join('\n') || 'None specified'}

## Previous Attempt Errors (Pattern Analysis)
${previousErrors.length > 0 ? previousErrors.join('\n\n') : 'This is the first attempt'}

## Recent File Changes
\`\`\`
${gitDiff}
\`\`\`

## Full Error Output (Last 200 lines)
\`\`\`
${fullOutput.split('\n').slice(-200).join('\n')}
\`\`\`

## Recommended Investigation Steps
1. Check if the error is a TypeScript/compilation error - look for specific file:line references
2. Check if it's a missing dependency - look for "Cannot find module" or "Module not found"
3. Check if it's a runtime error - look for stack traces
4. Compare with previous attempt errors to identify patterns
5. Review the git diff to see what changes might have caused the issue

## Key Questions for AI Analysis
- Is this error similar to previous attempts? If so, what's different this time?
- What specific file and line is causing the issue?
- Is there a pattern in the errors that suggests a root cause?
- What minimal change would fix this specific error?
`;

  await fs.ensureDir(path.dirname(errorReportPath));
  await fs.writeFile(errorReportPath, report);
  console.log(chalk.dim(`Detailed error report saved: ${errorReportPath}`));
}

/**
 * Handle when max attempts are reached - prompt user for options
 */
async function handleMaxAttemptsReached(
  phaseNumber: number,
  phase: any,
  lastError: string
): Promise<void> {
  console.log(chalk.red(`\n⛔ Phase ${phaseNumber} BLOCKED - all ${phase.max_attempts} attempts exhausted.\n`));
  console.log(chalk.dim('The AI was unable to complete this phase after multiple attempts.\n'));
  
  // Show error summary
  console.log(chalk.yellow('Last Error:'));
  console.log(chalk.dim(lastError.split('\n').slice(0, 5).join('\n')));
  console.log();
  
  // Prompt user for what to do
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '🔄 Add more retry attempts', value: 'retry' },
        { name: '🧠 Switch model and retry (Opus for deeper analysis)', value: 'switch_model' },
        { name: '📋 View detailed error reports', value: 'view_errors' },
        { name: '⏪ Rollback to before this phase', value: 'rollback' },
        { name: '🛑 Exit and fix manually', value: 'exit' },
      ],
    },
  ]);
  
  switch (action) {
    case 'retry': {
      const { additionalAttempts } = await inquirer.prompt([
        {
          type: 'number',
          name: 'additionalAttempts',
          message: 'How many additional attempts?',
          default: 3,
          validate: (input) => input > 0 && input <= 10 ? true : 'Please enter a number between 1 and 10',
        },
      ]);
      
      // Update phase max_attempts and reset status
      await updatePhaseState(phaseNumber, { 
        max_attempts: phase.max_attempts + additionalAttempts,
        status: 'failed', // Reset from blocked to allow retries
      });
      
      console.log(chalk.green(`\n✓ Added ${additionalAttempts} more attempts. Continuing...\n`));
      
      // Continue with retry
      await runCommand({ 
        phase: String(phaseNumber), 
        auto: true, 
        isRetry: true,
        errorContext: lastError,
        consecutiveErrors: 2, // Trigger enhanced analysis
      });
      break;
    }
    
    case 'switch_model': {
      const { model } = await inquirer.prompt([
        {
          type: 'list',
          name: 'model',
          message: 'Select model for retry:',
          choices: [
            { name: 'Claude Opus 4.5 (deeper analysis, slower)', value: 'claude-sonnet-4-20250514' },
            { name: 'Gemini 2.5 Flash (faster)', value: 'gemini-2.5-flash' },
          ],
        },
      ]);
      
      const { additionalAttempts } = await inquirer.prompt([
        {
          type: 'number',
          name: 'additionalAttempts',
          message: 'How many additional attempts with this model?',
          default: 2,
          validate: (input) => input > 0 && input <= 10 ? true : 'Please enter a number between 1 and 10',
        },
      ]);
      
      // Update phase and reset status
      await updatePhaseState(phaseNumber, { 
        max_attempts: phase.max_attempts + additionalAttempts,
        status: 'failed',
      });
      
      console.log(chalk.green(`\n✓ Switching to ${model} with ${additionalAttempts} more attempts...\n`));
      
      await runCommand({ 
        phase: String(phaseNumber), 
        auto: true, 
        isRetry: true,
        errorContext: lastError,
        consecutiveErrors: 2,
        modelOverride: model,
      });
      break;
    }
    
    case 'view_errors': {
      const phasesDir = getProjectPhasesDir();
      const phaseDir = path.join(phasesDir, 'phases', `phase-${phaseNumber}`);
      console.log(chalk.cyan(`\nError reports are in: ${phaseDir}`));
      console.log(chalk.dim('Look for detailed-error-report.md in each attempt folder.\n'));
      
      // Recursively call to let user choose again
      await handleMaxAttemptsReached(phaseNumber, phase, lastError);
      break;
    }
    
    case 'rollback': {
      console.log(chalk.yellow('\nTo rollback, run:'));
      console.log(chalk.cyan(`  ai-phases rollback --phase ${phaseNumber}\n`));
      break;
    }
    
    case 'exit':
    default:
      console.log(chalk.dim('\nExiting. Fix the issues manually and run:'));
      console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}\n`));
      break;
  }
}

/**
 * Auto-generate a COMPREHENSIVE handover summary from the phase output
 * This is CRITICAL - handovers must contain all important details for the next phase
 */
async function generateAutoHandover(
  phaseNumber: number,
  output: string,
  filesModified: string[]
): Promise<void> {
  const { runPlanningTask, extractMarkdown } = await import('../../core/cursor-cli.js');
  const state = await loadProjectState();
  const phase = state?.phases.find(p => p.phase_number === phaseNumber);
  
  // Get the actual file contents for key files (first 50 lines each)
  const fileSnippets: string[] = [];
  for (const file of filesModified.slice(0, 5)) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n').slice(0, 30).join('\n');
      fileSnippets.push(`### ${file}\n\`\`\`\n${lines}\n...\n\`\`\``);
    } catch {
      // File might not exist or be binary
    }
  }
  
  // Get task completion status
  const completedTasks = phase?.tasks.filter(t => t.status === 'completed') || [];
  const allTasksCompleted = phase?.tasks.length === completedTasks.length;
  
  const handoverPrompt = `You MUST generate a COMPREHENSIVE handover document for Phase ${phaseNumber}.

This handover is CRITICAL - it is the ONLY context the next AI agent will have about what was built.
If you skip details, the next phase WILL FAIL because the AI won't know what exists.

## Phase ${phaseNumber} Information
- **Name**: ${phase?.name || 'Unknown'}
- **Description**: ${phase?.description || 'Unknown'}
- **Status**: ${allTasksCompleted ? 'ALL TASKS COMPLETED ✓' : 'Some tasks may be incomplete'}

## Tasks and Their Status
${phase?.tasks.map(t => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.description} (${t.status})`).join('\n') || 'Unknown'}

## Phase Output (What the AI did)
${output.substring(0, 6000)}${output.length > 6000 ? '\n...(truncated)' : ''}

## Files Modified
${filesModified.map(f => `- ${f}`).join('\n')}

## Key File Contents (for reference)
${fileSnippets.join('\n\n')}

---

## MANDATORY OUTPUT FORMAT - Follow this EXACTLY:

# Handover - Phase ${phaseNumber}: ${phase?.name || 'Unknown'}

## ✅ What Was Completed
[List EVERY feature/component that was built - be specific with names and locations]
- Feature 1: Description and where it lives
- Feature 2: Description and where it lives
- etc.

## 📁 Key Files Created/Modified
| File Path | Purpose | Key Exports/Components |
|-----------|---------|----------------------|
| path/to/file | what it does | Button, Card, etc |

## 🔧 Technical Decisions Made
[Document any important decisions about architecture, libraries used, patterns followed]
- Decision 1: Why and what
- Decision 2: Why and what

## ⚠️ Important Notes for Next Phase
[Things the next AI MUST know to avoid breaking things]
- Note 1
- Note 2

## 🔗 Dependencies & Integrations
[What libraries were installed, what APIs are being used]
- Library: version - what for
- API: endpoint - what for

## 📋 What Validation Passed
${phase?.validation_criteria.map(c => `- ✓ ${c}`).join('\n') || 'None specified'}

## 🎯 Suggested Focus for Next Phase
[Based on what was built, what should the next phase focus on or be careful about]

---

IMPORTANT RULES:
1. Be SPECIFIC - use actual file names, component names, function names
2. Do NOT be vague like "some components were created" - say WHICH components
3. Include code snippets if they help explain a pattern
4. Err on the side of MORE detail, not less
5. This document should allow someone with NO context to understand what exists`;

  try {
    // Use planning model for better quality handovers
    const result = await runPlanningTask(handoverPrompt);
    
    if (result.success && result.output.trim().length > 100) {
      const handoverContent = extractMarkdown(result.output);
      const handoverPath = path.join(
        getProjectPhasesDir(),
        'phases',
        `phase-${phaseNumber}`,
        'handover.md'
      );
      await fs.writeFile(handoverPath, handoverContent);
      console.log(chalk.green('✓ Comprehensive handover generated: ') + chalk.dim(handoverPath));
    } else {
      // Fallback - generate a basic handover from available info
      console.log(chalk.yellow('⚠️  AI handover generation incomplete, creating fallback...'));
      await generateFallbackHandover(phaseNumber, phase, filesModified, output);
    }
  } catch (error) {
    // Fallback to basic handover if AI generation fails
    console.log(chalk.yellow('⚠️  AI handover generation failed, creating fallback...'));
    await generateFallbackHandover(phaseNumber, phase, filesModified, output);
  }
}

/**
 * Generate a fallback handover when AI generation fails
 * This ensures we ALWAYS have a handover document
 */
async function generateFallbackHandover(
  phaseNumber: number,
  phase: any,
  filesModified: string[],
  output: string
): Promise<void> {
  const handoverPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    'handover.md'
  );
  
  // Extract key info from output
  const outputLines = output.split('\n');
  const createdFiles = outputLines.filter(l => l.includes('Created') || l.includes('created')).slice(0, 10);
  const modifiedFiles = outputLines.filter(l => l.includes('Modified') || l.includes('modified')).slice(0, 10);
  
  const fallbackContent = `# Handover - Phase ${phaseNumber}: ${phase?.name || 'Unknown'}

## ⚠️ Auto-Generated Fallback Handover
This handover was auto-generated because the AI handover generation failed.
Please review and enhance if needed.

## ✅ Phase Information
- **Phase**: ${phaseNumber}
- **Name**: ${phase?.name || 'Unknown'}
- **Description**: ${phase?.description || 'Unknown'}

## 📋 Tasks and Status
${phase?.tasks.map((t: any, i: number) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.description} (${t.status})`).join('\n') || 'Unknown'}

## 📁 Files Modified
${filesModified.map(f => `- \`${f}\``).join('\n') || 'No files recorded'}

## 📝 Creation/Modification Mentions in Output
${createdFiles.concat(modifiedFiles).map(l => `- ${l.trim()}`).join('\n') || 'None detected'}

## ✓ Validation Criteria
${phase?.validation_criteria?.map((c: string) => `- ${c}`).join('\n') || 'None specified'}

## ⚠️ Important for Next Phase
- Review the files listed above before making changes
- Check imports and dependencies are correct
- Verify the validation commands still pass

## 📊 Raw Output Summary (First 50 lines)
\`\`\`
${outputLines.slice(0, 50).join('\n')}
\`\`\`
`;

  await fs.ensureDir(path.dirname(handoverPath));
  await fs.writeFile(handoverPath, fallbackContent);
  console.log(chalk.green('✓ Fallback handover created: ') + chalk.dim(handoverPath));
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
