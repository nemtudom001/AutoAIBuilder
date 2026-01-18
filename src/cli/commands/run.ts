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
} from '../../core/git-integration.js';
import {
  runCursorAgent,
  isCursorCliInstalled,
  getCursorApiKey,
} from '../../core/cursor-cli.js';

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
  
  // Verify CLI setup
  const cliInstalled = await isCursorCliInstalled();
  if (!cliInstalled) {
    console.log(chalk.red('\n✗ cursor-agent CLI not found.'));
    console.log(chalk.dim('Install with: curl https://cursor.com/install -fsS | bash\n'));
    process.exit(1);
  }
  
  const apiKey = await getCursorApiKey();
  if (!apiKey) {
    console.log(chalk.red('\n✗ Cursor API key not configured.'));
    console.log(chalk.dim('Run: ai-phases config --setup\n'));
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
    // Get modified files from git (more reliable than parsing output)
    const gitStatus = await getGitStatus();
    const filesModified = [...gitStatus.modifiedFiles, ...gitStatus.untrackedFiles];
    
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
