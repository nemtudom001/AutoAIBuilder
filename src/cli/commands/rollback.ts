import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { getProjectPhasesDir } from '../../core/config-manager.js';
import {
  loadProjectState,
  saveProjectState,
  loadPhaseState,
  updatePhaseState,
  loadAttemptState,
} from '../../core/state-manager.js';
import { rollbackToCheckpoint, getGitStatus } from '../../core/git-integration.js';

interface RollbackOptions {
  phase?: string;
}

export async function rollbackCommand(options: RollbackOptions): Promise<void> {
  const state = await loadProjectState();
  if (!state) {
    console.log(chalk.yellow('Project not initialized. Run: ai-phases init'));
    process.exit(1);
  }
  
  // Determine phase to rollback
  let phaseNumber: number;
  if (options.phase) {
    phaseNumber = parseInt(options.phase, 10);
  } else {
    // Find the current or most recently failed phase
    const failedPhases = state.phases
      .filter(p => p.status === 'failed' || p.status === 'blocked' || p.status === 'in_progress')
      .sort((a, b) => b.phase_number - a.phase_number);
    
    if (failedPhases.length === 0) {
      console.log(chalk.yellow('No phases available for rollback.'));
      return;
    }
    
    const { selectedPhase } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedPhase',
        message: 'Select phase to rollback:',
        choices: failedPhases.map(p => ({
          name: `Phase ${p.phase_number}: ${p.name} (${p.status})`,
          value: p.phase_number,
        })),
      },
    ]);
    
    phaseNumber = selectedPhase;
  }
  
  const phase = await loadPhaseState(phaseNumber);
  if (!phase) {
    console.log(chalk.red(`Phase ${phaseNumber} not found.`));
    return;
  }
  
  console.log(chalk.yellow(`\n⚠️  Rollback Phase ${phaseNumber}: ${phase.name}\n`));
  
  // Show current state
  console.log(chalk.dim('Current state:'));
  console.log(chalk.dim(`  Status: ${phase.status}`));
  console.log(chalk.dim(`  Attempts: ${phase.current_attempt}/${phase.max_attempts}`));
  console.log();
  
  // Check git status
  const gitStatus = await getGitStatus();
  if (gitStatus.hasChanges) {
    console.log(chalk.yellow('⚠️  You have uncommitted changes:'));
    console.log(chalk.dim(`  Modified: ${gitStatus.modifiedFiles.length} files`));
    console.log(chalk.dim(`  Untracked: ${gitStatus.untrackedFiles.length} files`));
    console.log();
  }
  
  // Determine rollback type
  const { rollbackType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'rollbackType',
      message: 'What type of rollback?',
      choices: [
        {
          name: 'Soft rollback - Reset phase state only (keep code changes)',
          value: 'soft',
        },
        {
          name: 'Hard rollback - Reset state AND revert code to previous checkpoint',
          value: 'hard',
        },
        {
          name: 'Cancel',
          value: 'cancel',
        },
      ],
    },
  ]);
  
  if (rollbackType === 'cancel') {
    console.log(chalk.dim('Rollback cancelled.'));
    return;
  }
  
  // Confirm
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Confirm ${rollbackType} rollback of Phase ${phaseNumber}?`,
      default: false,
    },
  ]);
  
  if (!confirm) {
    console.log(chalk.dim('Rollback cancelled.'));
    return;
  }
  
  const spinner = ora('Rolling back...').start();
  
  try {
    // Get failure information for the handover note
    let failureContext = '';
    if (phase.current_attempt > 0) {
      const lastAttempt = await loadAttemptState(phaseNumber, phase.current_attempt);
      if (lastAttempt && lastAttempt.error_summary) {
        failureContext = lastAttempt.error_summary;
      }
    }
    
    // Hard rollback - revert git changes
    if (rollbackType === 'hard' && gitStatus.isRepo) {
      const targetAttempt = phase.current_attempt > 1 ? phase.current_attempt - 1 : 1;
      const rolledBack = await rollbackToCheckpoint(phaseNumber, targetAttempt);
      
      if (!rolledBack) {
        spinner.warn('Could not find git checkpoint, performing soft rollback only');
      }
    }
    
    // Reset phase state
    const isBlocked = phase.status === 'blocked';
    const newAttempt = isBlocked ? 0 : Math.max(0, phase.current_attempt - 1);
    
    await updatePhaseState(phaseNumber, {
      status: 'pending',
      current_attempt: newAttempt,
      completed_at: undefined,
    });
    
    // Update project state
    state.status = 'in_progress';
    state.current_phase = phaseNumber;
    await saveProjectState(state);
    
    // Create rollback note for next attempt
    const rollbackNotePath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      'rollback-note.md'
    );
    
    const rollbackNote = `# Rollback Note - Phase ${phaseNumber}

## Rollback Date
${new Date().toISOString()}

## Rollback Type
${rollbackType === 'hard' ? 'Hard (code reverted)' : 'Soft (state only)'}

## Why This Phase Failed
${failureContext || 'No specific failure information recorded.'}

## What to Try Differently
Based on previous attempts, consider:
1. Review the error messages and stack traces
2. Check if dependencies are correctly installed
3. Verify the approach aligns with the project architecture
4. Consider breaking this phase into smaller steps

## Previous Attempt History
${Array.from({ length: phase.current_attempt }, (_, i) => i + 1)
  .map(n => `- Attempt ${n}: See attempt-${n}/failure-report.md`)
  .join('\n') || 'No previous attempts recorded.'}
`;
    
    await fs.ensureDir(path.dirname(rollbackNotePath));
    await fs.writeFile(rollbackNotePath, rollbackNote);
    
    // Remove BLOCKED.md if it exists
    if (isBlocked) {
      const blockedPath = path.join(
        getProjectPhasesDir(),
        'phases',
        `phase-${phaseNumber}`,
        'BLOCKED.md'
      );
      if (await fs.pathExists(blockedPath)) {
        await fs.remove(blockedPath);
      }
    }
    
    spinner.succeed('Rollback complete!');
    
    console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green.bold('  ✓ Phase Rolled Back'));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    console.log(chalk.dim('Rollback note saved to:'));
    console.log(chalk.cyan(`  ${rollbackNotePath}\n`));
    
    if (isBlocked) {
      console.log(chalk.green('Phase unblocked! Attempt counter reset.\n'));
    }
    
    console.log(chalk.white('Next step:'));
    console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber}`));
    console.log(chalk.dim('\nReview the rollback note before starting the next attempt.\n'));
    
  } catch (error) {
    spinner.fail('Rollback failed');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  }
}
