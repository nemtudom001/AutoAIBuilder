import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';

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
    // Try to get branch name with fallback
    let branch = 'main';
    try {
      const { stdout } = await execAsync('git branch --show-current');
      branch = stdout.trim() || 'main';
    } catch {
      // Fallback to main
    }
    
    return {
      isRepo: true,
      branch,
      hasChanges: false,
      modifiedFiles: [],
      untrackedFiles: [],
      currentCommit: '',
    };
  }
}

/**
 * Initialize git repository if not already initialized
 * Also ensures a proper .gitignore exists
 */
export async function initGitRepo(): Promise<void> {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    await execAsync('git init');
    console.log(chalk.green('✓ Initialized git repository'));
  }
  
  // Ensure .gitignore exists with essential patterns
  await ensureGitignore();
}

/**
 * Ensure .gitignore has essential patterns to prevent large file commits
 */
export async function ensureGitignore(): Promise<void> {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  
  const essentialPatterns = [
    '# Dependencies',
    'node_modules/',
    '',
    '# Build output',
    '.next/',
    'dist/',
    'build/',
    'out/',
    '',
    '# IDE',
    '.idea/',
    '.vscode/',
    '*.swp',
    '*.swo',
    '',
    '# Environment',
    '.env',
    '.env.local',
    '.env.*.local',
    '',
    '# OS',
    '.DS_Store',
    'Thumbs.db',
    '',
    '# Debug',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    '',
    '# Testing',
    'coverage/',
    '',
    '# Misc',
    '*.tsbuildinfo',
  ];
  
  let existingContent = '';
  if (await fs.pathExists(gitignorePath)) {
    existingContent = await fs.readFile(gitignorePath, 'utf-8');
  }
  
  // Check which essential patterns are missing
  const missingPatterns: string[] = [];
  for (const pattern of essentialPatterns) {
    if (pattern === '' || pattern.startsWith('#')) continue;
    // Check if pattern (or a less specific version) already exists
    const patternWithoutSlash = pattern.replace(/\/$/, '');
    if (!existingContent.includes(pattern) && !existingContent.includes(patternWithoutSlash)) {
      missingPatterns.push(pattern);
    }
  }
  
  if (missingPatterns.length > 0) {
    // If file doesn't exist or is empty, write the full template
    if (!existingContent.trim()) {
      await fs.writeFile(gitignorePath, essentialPatterns.join('\n') + '\n');
    } else {
      // Append missing patterns
      const toAdd = '\n# Added by AI Phase Builder\n' + missingPatterns.join('\n') + '\n';
      await fs.appendFile(gitignorePath, toAdd);
    }
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
    // Ensure .gitignore exists before staging to prevent committing large files
    await ensureGitignore();
    
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

/**
 * Check if gh CLI is installed and authenticated
 */
export async function isGhCliReady(): Promise<boolean> {
  try {
    await execAsync('gh auth status', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if remote 'origin' exists
 */
export async function hasRemote(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git remote get-url origin');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a GitHub repository for the project
 */
export async function createGitHubRepo(
  projectName: string,
  visibility: 'private' | 'public' = 'private'
): Promise<{ success: boolean; url?: string; error?: string }> {
  // Check if gh CLI is ready
  const ghReady = await isGhCliReady();
  if (!ghReady) {
    return {
      success: false,
      error: 'GitHub CLI not authenticated. Run: gh auth login',
    };
  }

  // Check if already has remote
  if (await hasRemote()) {
    try {
      const { stdout } = await execAsync('git remote get-url origin');
      return {
        success: true,
        url: stdout.trim(),
      };
    } catch {
      // Continue to create new repo
    }
  }

  // Ensure git is initialized
  const isRepo = await isGitRepo();
  if (!isRepo) {
    await execAsync('git init');
    console.log(chalk.dim('  Initialized git repository'));
  }

  // Ensure .gitignore exists before any commits
  await ensureGitignore();
  
  // Create initial commit if no commits exist
  try {
    await execAsync('git rev-parse HEAD');
  } catch {
    // No commits yet, create initial commit
    await execAsync('git add -A');
    try {
      await execAsync('git commit -m "Initial commit"');
      console.log(chalk.dim('  Created initial commit'));
    } catch {
      // Nothing to commit, that's fine
    }
  }

  // Sanitize project name for repo name
  const repoName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  try {
    // Create repo on GitHub
    const visibilityFlag = visibility === 'private' ? '--private' : '--public';
    const { stdout } = await execAsync(
      `gh repo create "${repoName}" ${visibilityFlag} --source=. --remote=origin --push`,
      { timeout: 60000 }
    );

    // Extract URL from output
    const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : stdout.trim().split('\n')[0];

    console.log(chalk.green(`✓ Created GitHub repo: ${url}`));
    return { success: true, url };
  } catch (error: any) {
    // Check if repo already exists
    if (error.message?.includes('already exists')) {
      // Try to set remote to existing repo
      try {
        const { stdout: username } = await execAsync('gh api user -q .login');
        const repoUrl = `https://github.com/${username.trim()}/${repoName}`;
        await execAsync(`git remote add origin ${repoUrl}`);
        await execAsync('git push -u origin main');
        return { success: true, url: repoUrl };
      } catch {
        return {
          success: false,
          error: `Repository "${repoName}" already exists. Set remote manually.`,
        };
      }
    }

    return {
      success: false,
      error: error.message || 'Failed to create GitHub repository',
    };
  }
}

/**
 * Push current branch to remote
 */
export async function pushToRemote(): Promise<{ success: boolean; error?: string }> {
  const status = await getGitStatus();

  if (!status.isRepo) {
    return { success: false, error: 'Not a git repository' };
  }

  // Check if remote exists
  const hasOrigin = await hasRemote();
  if (!hasOrigin) {
    return { success: false, error: 'No remote configured' };
  }

  try {
    // Get current branch - try to detect it reliably
    let branch = status.branch;
    if (!branch || branch === 'unknown') {
      try {
        const { stdout } = await execAsync('git branch --show-current');
        branch = stdout.trim();
      } catch {
        branch = 'main';
      }
    }
    
    if (!branch) {
      branch = 'main';
    }
    
    // Push with upstream tracking
    await execAsync(`git push -u origin ${branch}`, { timeout: 60000 });
    console.log(chalk.green('✓ Pushed to remote'));
    return { success: true };
  } catch (error: any) {
    // Check if it's just "nothing to push"
    if (error.message?.includes('Everything up-to-date')) {
      return { success: true };
    }
    return {
      success: false,
      error: error.message || 'Failed to push to remote',
    };
  }
}

/**
 * Push tags to remote
 */
export async function pushTagsToRemote(): Promise<boolean> {
  try {
    await execAsync('git push --tags', { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}
