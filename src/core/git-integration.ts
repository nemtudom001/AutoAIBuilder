import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execAsync = promisify(exec);

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  hasChanges: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  currentCommit: string;
}

/**
 * Check if current directory is a git repository
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git status
 */
export async function getGitStatus(): Promise<GitStatus> {
  const isRepo = await isGitRepo();
  
  if (!isRepo) {
    return {
      isRepo: false,
      branch: '',
      hasChanges: false,
      modifiedFiles: [],
      untrackedFiles: [],
      currentCommit: '',
    };
  }
  
  try {
    const [branchResult, statusResult, commitResult] = await Promise.all([
      execAsync('git branch --show-current'),
      execAsync('git status --porcelain'),
      execAsync('git rev-parse HEAD'),
    ]);
    
    const statusLines = statusResult.stdout.trim().split('\n').filter(Boolean);
    const modifiedFiles: string[] = [];
    const untrackedFiles: string[] = [];
    
    for (const line of statusLines) {
      const status = line.substring(0, 2);
      const file = line.substring(3);
      
      if (status.includes('?')) {
        untrackedFiles.push(file);
      } else {
        modifiedFiles.push(file);
      }
    }
    
    return {
      isRepo: true,
      branch: branchResult.stdout.trim(),
      hasChanges: statusLines.length > 0,
      modifiedFiles,
      untrackedFiles,
      currentCommit: commitResult.stdout.trim(),
    };
  } catch (error) {
    return {
      isRepo: true,
      branch: 'unknown',
      hasChanges: false,
      modifiedFiles: [],
      untrackedFiles: [],
      currentCommit: '',
    };
  }
}

/**
 * Initialize git repository if not already initialized
 */
export async function initGitRepo(): Promise<void> {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    await execAsync('git init');
    console.log(chalk.green('✓ Initialized git repository'));
  }
}

/**
 * Create a commit for a phase completion
 */
export async function commitPhaseCompletion(
  phaseNumber: number,
  phaseName: string,
  attemptNumber: number
): Promise<string | null> {
  const status = await getGitStatus();
  
  if (!status.isRepo) {
    console.log(chalk.yellow('⚠️  Not a git repository, skipping commit'));
    return null;
  }
  
  if (!status.hasChanges) {
    console.log(chalk.dim('No changes to commit'));
    return status.currentCommit;
  }
  
  try {
    // Stage all changes
    await execAsync('git add -A');
    
    // Create commit
    const message = `[ai-phases] Phase ${phaseNumber}: ${phaseName} (attempt ${attemptNumber})`;
    await execAsync(`git commit -m "${message}"`);
    
    // Get new commit hash
    const { stdout } = await execAsync('git rev-parse HEAD');
    const commitHash = stdout.trim();
    
    console.log(chalk.green(`✓ Committed: ${commitHash.substring(0, 7)}`));
    return commitHash;
  } catch (error) {
    console.log(chalk.yellow('⚠️  Failed to commit changes'));
    return null;
  }
}

/**
 * Create a checkpoint tag for a phase
 */
export async function createPhaseCheckpoint(
  phaseNumber: number,
  attemptNumber: number
): Promise<string | null> {
  const status = await getGitStatus();
  
  if (!status.isRepo) {
    return null;
  }
  
  try {
    const tagName = `ai-phases/phase-${phaseNumber}/attempt-${attemptNumber}`;
    await execAsync(`git tag -f "${tagName}"`);
    console.log(chalk.green(`✓ Created checkpoint: ${tagName}`));
    return tagName;
  } catch {
    return null;
  }
}

/**
 * Rollback to a specific phase checkpoint
 */
export async function rollbackToCheckpoint(
  phaseNumber: number,
  attemptNumber: number
): Promise<boolean> {
  const status = await getGitStatus();
  
  if (!status.isRepo) {
    console.log(chalk.red('✗ Not a git repository, cannot rollback'));
    return false;
  }
  
  try {
    // Check if we have uncommitted changes
    if (status.hasChanges) {
      // Stash changes first
      await execAsync('git stash push -m "ai-phases: pre-rollback stash"');
      console.log(chalk.dim('Stashed uncommitted changes'));
    }
    
    // Try to find the checkpoint tag
    const tagName = `ai-phases/phase-${phaseNumber}/attempt-${attemptNumber}`;
    
    try {
      await execAsync(`git rev-parse "${tagName}"`);
      // Tag exists, reset to it
      await execAsync(`git reset --hard "${tagName}"`);
      console.log(chalk.green(`✓ Rolled back to ${tagName}`));
      return true;
    } catch {
      // Tag doesn't exist, try to find the phase commit
      const { stdout } = await execAsync(
        `git log --oneline --grep="\\[ai-phases\\] Phase ${phaseNumber}:" -n 1`
      );
      
      if (stdout.trim()) {
        const commitHash = stdout.trim().split(' ')[0];
        // Reset to the commit before this one
        await execAsync(`git reset --hard ${commitHash}~1`);
        console.log(chalk.green(`✓ Rolled back to commit before phase ${phaseNumber}`));
        return true;
      }
    }
    
    console.log(chalk.yellow(`⚠️  No checkpoint found for phase ${phaseNumber}, attempt ${attemptNumber}`));
    return false;
  } catch (error) {
    console.log(chalk.red('✗ Rollback failed'));
    return false;
  }
}

/**
 * Get list of files changed since a specific commit
 */
export async function getChangedFilesSince(commitHash: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git diff --name-only ${commitHash}`);
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Detect drift - files changed outside of phase runs
 */
export async function detectDrift(lastKnownCommit: string): Promise<{
  hasDrift: boolean;
  changedFiles: string[];
  newCommits: number;
}> {
  const status = await getGitStatus();
  
  if (!status.isRepo || !lastKnownCommit) {
    return { hasDrift: false, changedFiles: [], newCommits: 0 };
  }
  
  try {
    // Get commits since last known
    const { stdout: commitCount } = await execAsync(
      `git rev-list --count ${lastKnownCommit}..HEAD`
    );
    const newCommits = parseInt(commitCount.trim(), 10);
    
    // Get changed files
    const changedFiles = await getChangedFilesSince(lastKnownCommit);
    
    // Also include uncommitted changes
    const allChanged = [...new Set([...changedFiles, ...status.modifiedFiles, ...status.untrackedFiles])];
    
    return {
      hasDrift: allChanged.length > 0,
      changedFiles: allChanged,
      newCommits,
    };
  } catch {
    return { hasDrift: false, changedFiles: [], newCommits: 0 };
  }
}

/**
 * Store base commit for drift detection
 */
export async function getBaseCommit(): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD');
    return stdout.trim();
  } catch {
    return '';
  }
}
