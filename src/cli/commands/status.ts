import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import { loadProjectConfig, loadGlobalConfig } from '../../core/config-manager.js';
import { loadProjectState, getCurrentPhaseInfo } from '../../core/state-manager.js';
import { getGitStatus, detectDrift } from '../../core/git-integration.js';

interface StatusOptions {
  verbose?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
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
  
  const globalConfig = await loadGlobalConfig();
  
  // Header
  console.log(
    boxen(
      chalk.bold.cyan(`📊 ${state.project_name}`) +
      '\n' +
      chalk.dim(`Status: ${getStatusEmoji(state.status)} ${state.status.toUpperCase()}`),
      {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: getStatusColor(state.status),
      }
    )
  );
  
  // Progress summary
  const completedPhases = state.phases.filter(p => p.status === 'completed').length;
  const progressPercent = state.total_phases > 0 
    ? Math.round((completedPhases / state.total_phases) * 100) 
    : 0;
  
  console.log(chalk.white('Progress:'));
  console.log(chalk.dim('  Phases: ') + chalk.cyan(`${completedPhases}/${state.total_phases}`) + chalk.dim(` (${progressPercent}%)`));
  
  // Progress bar
  const barLength = 30;
  const filled = Math.round((completedPhases / state.total_phases) * barLength) || 0;
  const empty = barLength - filled;
  const progressBar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
  console.log(chalk.dim('  ') + progressBar + '\n');
  
  // Phase table
  if (state.phases.length > 0) {
    const table = new Table({
      head: [
        chalk.white('Phase'),
        chalk.white('Name'),
        chalk.white('Status'),
        chalk.white('Attempt'),
      ],
      style: {
        head: [],
        border: ['dim'],
      },
    });
    
    state.phases.forEach(phase => {
      const isCurrent = phase.phase_number === state.current_phase;
      const phaseNum = isCurrent 
        ? chalk.cyan.bold(`→ ${phase.phase_number}`) 
        : chalk.dim(`  ${phase.phase_number}`);
      
      const statusDisplay = getPhaseStatusDisplay(phase.status);
      const attemptDisplay = phase.status === 'blocked'
        ? chalk.red(`${phase.current_attempt}/${phase.max_attempts} ⛔`)
        : chalk.dim(`${phase.current_attempt}/${phase.max_attempts}`);
      
      table.push([
        phaseNum,
        isCurrent ? chalk.white(phase.name) : chalk.dim(phase.name),
        statusDisplay,
        attemptDisplay,
      ]);
    });
    
    console.log(table.toString());
    console.log();
  }
  
  // Current phase details
  const currentInfo = await getCurrentPhaseInfo();
  if (currentInfo) {
    console.log(chalk.white('Current Phase:'));
    console.log(chalk.dim('  Phase: ') + chalk.cyan(`${currentInfo.phase.phase_number}. ${currentInfo.phase.name}`));
    console.log(chalk.dim('  Status: ') + getPhaseStatusDisplay(currentInfo.phase.status));
    console.log(chalk.dim('  Model: ') + chalk.white(
      currentInfo.phase.model === 'planning' 
        ? globalConfig?.cursor.planning_model 
        : globalConfig?.cursor.execution_model
    ));
    
    if (currentInfo.phase.tasks.length > 0) {
      console.log(chalk.dim('  Tasks: '));
      currentInfo.phase.tasks.forEach(task => {
        const status = task.status === 'completed' ? chalk.green('✓') : chalk.dim('○');
        console.log(chalk.dim(`    ${status} ${task.description}`));
      });
    }
    
    if (!currentInfo.canRetry && currentInfo.phase.status === 'failed') {
      console.log(chalk.red('\n  ⚠️  No retries remaining. Phase will be blocked on next failure.'));
    }
    console.log();
  }
  
  // Git status
  if (options.verbose) {
    const gitStatus = await getGitStatus();
    console.log(chalk.white('Git Status:'));
    console.log(chalk.dim('  Repository: ') + (gitStatus.isRepo ? chalk.green('Yes') : chalk.yellow('No')));
    if (gitStatus.isRepo) {
      console.log(chalk.dim('  Branch: ') + chalk.white(gitStatus.branch));
      console.log(chalk.dim('  Uncommitted changes: ') + (gitStatus.hasChanges ? chalk.yellow('Yes') : chalk.green('No')));
      
      if (gitStatus.hasChanges) {
        console.log(chalk.dim('  Modified files: ') + chalk.white(gitStatus.modifiedFiles.length.toString()));
        console.log(chalk.dim('  Untracked files: ') + chalk.white(gitStatus.untrackedFiles.length.toString()));
      }
    }
    console.log();
    
    // Drift detection
    if (state.git_base_commit) {
      const drift = await detectDrift(state.git_base_commit);
      if (drift.hasDrift) {
        console.log(chalk.yellow('⚠️  Drift Detected:'));
        console.log(chalk.dim('  Files changed outside of phase runs: ') + chalk.white(drift.changedFiles.length.toString()));
        if (drift.newCommits > 0) {
          console.log(chalk.dim('  New commits: ') + chalk.white(drift.newCommits.toString()));
        }
        console.log(chalk.dim('  Run ') + chalk.cyan('ai-phases sync') + chalk.dim(' to reconcile.\n'));
      }
    }
  }
  
  // Quick actions
  console.log(chalk.white('Quick Actions:'));
  if (state.status === 'planning' || state.phases.length === 0) {
    console.log(chalk.cyan('  ai-phases refine "your idea"  ') + chalk.dim('- Start with an idea'));
    console.log(chalk.cyan('  ai-phases plan --interactive  ') + chalk.dim('- Manual phase planning'));
  } else if (state.status === 'blocked') {
    console.log(chalk.cyan('  ai-phases rollback            ') + chalk.dim('- Rollback blocked phase'));
  } else if (state.status === 'completed') {
    console.log(chalk.green('  🎉 Project complete!'));
  } else {
    console.log(chalk.cyan(`  ai-phases run --phase ${state.current_phase}      `) + chalk.dim('- Continue current phase'));
    console.log(chalk.cyan('  ai-phases handover            ') + chalk.dim('- Generate handover'));
  }
  console.log();
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'planning': return '📝';
    case 'refining': return '🔮';
    case 'in_progress': return '🚧';
    case 'completed': return '✅';
    case 'blocked': return '⛔';
    default: return '❓';
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed': return 'green';
    case 'blocked': return 'red';
    case 'in_progress': return 'cyan';
    default: return 'white';
  }
}

function getPhaseStatusDisplay(status: string): string {
  switch (status) {
    case 'pending': return chalk.dim('○ Pending');
    case 'in_progress': return chalk.cyan('◐ In Progress');
    case 'completed': return chalk.green('✓ Complete');
    case 'failed': return chalk.yellow('✗ Failed');
    case 'blocked': return chalk.red('⛔ Blocked');
    default: return chalk.dim(status);
  }
}
