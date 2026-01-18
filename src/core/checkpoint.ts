import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getProjectPhasesDir } from './config-manager.js';

const execAsync = promisify(exec);

export interface Checkpoint {
  id: string;
  phaseNumber: number;
  attemptNumber: number;
  taskIndex: number;
  taskDescription: string;
  timestamp: string;
  gitCommit?: string;
  filesModified: string[];
  status: 'created' | 'restored';
}

export interface CheckpointState {
  checkpoints: Checkpoint[];
  lastCheckpoint?: string;
}

/**
 * Create a checkpoint after completing a task within a phase
 * This allows recovery without losing all progress
 */
export async function createCheckpoint(
  phaseNumber: number,
  attemptNumber: number,
  taskIndex: number,
  taskDescription: string,
  filesModified: string[]
): Promise<Checkpoint | null> {
  const checkpointId = `phase-${phaseNumber}-attempt-${attemptNumber}-task-${taskIndex}`;
  const timestamp = new Date().toISOString();

  try {
    // Create a git stash or commit for the checkpoint
    let gitCommit: string | undefined;
    
    // Check if there are changes to save
    const { stdout: statusOutput } = await execAsync('git status --porcelain');
    if (statusOutput.trim()) {
      // Stage and commit checkpoint
      await execAsync('git add -A');
      await execAsync(`git commit -m "[checkpoint] Phase ${phaseNumber} Task ${taskIndex + 1}: ${taskDescription.substring(0, 50)}"`);
      
      const { stdout: commitHash } = await execAsync('git rev-parse HEAD');
      gitCommit = commitHash.trim();
    }

    const checkpoint: Checkpoint = {
      id: checkpointId,
      phaseNumber,
      attemptNumber,
      taskIndex,
      taskDescription,
      timestamp,
      gitCommit,
      filesModified,
      status: 'created',
    };

    // Save checkpoint state
    await saveCheckpointState(phaseNumber, attemptNumber, checkpoint);

    console.log(chalk.dim(`  📍 Checkpoint saved: Task ${taskIndex + 1}`));
    
    return checkpoint;
  } catch (error) {
    // Checkpoint creation is optional, don't fail
    console.log(chalk.dim(`  ⚠ Could not create checkpoint for task ${taskIndex + 1}`));
    return null;
  }
}

/**
 * Save checkpoint state to file
 */
async function saveCheckpointState(
  phaseNumber: number,
  attemptNumber: number,
  checkpoint: Checkpoint
): Promise<void> {
  const checkpointDir = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'checkpoints'
  );

  await fs.ensureDir(checkpointDir);

  // Save individual checkpoint
  const checkpointPath = path.join(checkpointDir, `${checkpoint.id}.json`);
  await fs.writeJson(checkpointPath, checkpoint, { spaces: 2 });

  // Update checkpoint index
  const indexPath = path.join(checkpointDir, 'index.json');
  let state: CheckpointState = { checkpoints: [] };
  
  if (await fs.pathExists(indexPath)) {
    state = await fs.readJson(indexPath);
  }

  // Add or update checkpoint
  const existingIndex = state.checkpoints.findIndex(c => c.id === checkpoint.id);
  if (existingIndex >= 0) {
    state.checkpoints[existingIndex] = checkpoint;
  } else {
    state.checkpoints.push(checkpoint);
  }
  state.lastCheckpoint = checkpoint.id;

  await fs.writeJson(indexPath, state, { spaces: 2 });
}

/**
 * Get all checkpoints for a phase attempt
 */
export async function getCheckpoints(
  phaseNumber: number,
  attemptNumber: number
): Promise<Checkpoint[]> {
  const indexPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'checkpoints',
    'index.json'
  );

  if (await fs.pathExists(indexPath)) {
    const state: CheckpointState = await fs.readJson(indexPath);
    return state.checkpoints;
  }

  return [];
}

/**
 * Get the last checkpoint for a phase attempt
 */
export async function getLastCheckpoint(
  phaseNumber: number,
  attemptNumber: number
): Promise<Checkpoint | null> {
  const checkpoints = await getCheckpoints(phaseNumber, attemptNumber);
  if (checkpoints.length === 0) return null;
  
  // Return the most recent checkpoint
  return checkpoints.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )[0];
}

/**
 * Restore to a specific checkpoint
 */
export async function restoreCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
  if (!checkpoint.gitCommit) {
    console.log(chalk.yellow('⚠ Checkpoint has no git commit to restore'));
    return false;
  }

  try {
    // Check for uncommitted changes
    const { stdout: statusOutput } = await execAsync('git status --porcelain');
    if (statusOutput.trim()) {
      // Stash current changes
      await execAsync('git stash push -m "Pre-restore stash"');
      console.log(chalk.dim('  Stashed current changes'));
    }

    // Reset to checkpoint commit
    await execAsync(`git reset --hard ${checkpoint.gitCommit}`);
    console.log(chalk.green(`✓ Restored to checkpoint: ${checkpoint.id}`));
    
    return true;
  } catch (error) {
    console.log(chalk.red('✗ Failed to restore checkpoint'));
    return false;
  }
}

/**
 * Display available checkpoints
 */
export function displayCheckpoints(checkpoints: Checkpoint[]): void {
  if (checkpoints.length === 0) {
    console.log(chalk.dim('No checkpoints available'));
    return;
  }

  console.log(chalk.cyan('\n📍 Available Checkpoints:\n'));
  
  checkpoints.forEach((cp, i) => {
    const date = new Date(cp.timestamp).toLocaleString();
    const commitShort = cp.gitCommit?.substring(0, 7) || 'no-commit';
    console.log(chalk.white(`  ${i + 1}. Task ${cp.taskIndex + 1}: ${cp.taskDescription.substring(0, 40)}...`));
    console.log(chalk.dim(`     ${date} | ${commitShort} | ${cp.filesModified.length} files`));
  });

  console.log();
}

/**
 * Get checkpoint recovery instructions for a failed phase
 */
export async function getCheckpointRecoveryInfo(
  phaseNumber: number,
  attemptNumber: number
): Promise<string> {
  const checkpoints = await getCheckpoints(phaseNumber, attemptNumber);
  
  if (checkpoints.length === 0) {
    return 'No checkpoints available for recovery.';
  }

  const lastCp = checkpoints[checkpoints.length - 1];
  const completedTasks = checkpoints.map(cp => `✓ Task ${cp.taskIndex + 1}: ${cp.taskDescription}`);

  return `
## Checkpoint Recovery Available

${completedTasks.length} task(s) were checkpointed before failure:
${completedTasks.join('\n')}

Last successful checkpoint: Task ${lastCp.taskIndex + 1}
Commit: ${lastCp.gitCommit || 'N/A'}

To recover, the next attempt can resume from task ${lastCp.taskIndex + 2}.
`;
}
