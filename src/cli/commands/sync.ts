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
} from '../../core/state-manager.js';
import { detectDrift, getGitStatus, getBaseCommit } from '../../core/git-integration.js';

interface SyncOptions {
  auto?: boolean;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const state = await loadProjectState();
  if (!state) {
    console.log(chalk.yellow('Project not initialized. Run: ai-phases init'));
    process.exit(1);
  }
  
  console.log(chalk.cyan('\n🔄 Checking for drift...\n'));
  
  const gitStatus = await getGitStatus();
  
  if (!gitStatus.isRepo) {
    console.log(chalk.yellow('Not a git repository. Drift detection requires git.'));
    console.log(chalk.dim('Initialize git with: git init\n'));
    return;
  }
  
  // Check for drift since last known commit
  const drift = state.git_base_commit 
    ? await detectDrift(state.git_base_commit)
    : { hasDrift: false, changedFiles: [], newCommits: 0 };
  
  // Also check for uncommitted changes
  const uncommittedChanges = [...gitStatus.modifiedFiles, ...gitStatus.untrackedFiles];
  
  if (!drift.hasDrift && uncommittedChanges.length === 0) {
    console.log(chalk.green('✓ No drift detected. Project state is in sync.\n'));
    return;
  }
  
  // Display drift info
  console.log(chalk.yellow('⚠️  Drift Detected\n'));
  
  if (drift.newCommits > 0) {
    console.log(chalk.white(`New commits since last phase: ${drift.newCommits}`));
  }
  
  if (drift.changedFiles.length > 0) {
    console.log(chalk.white('\nFiles changed outside of phase runs:'));
    drift.changedFiles.slice(0, 20).forEach(file => {
      console.log(chalk.dim(`  • ${file}`));
    });
    if (drift.changedFiles.length > 20) {
      console.log(chalk.dim(`  ... and ${drift.changedFiles.length - 20} more`));
    }
  }
  
  if (uncommittedChanges.length > 0) {
    console.log(chalk.white('\nUncommitted changes:'));
    uncommittedChanges.slice(0, 10).forEach(file => {
      console.log(chalk.dim(`  • ${file}`));
    });
    if (uncommittedChanges.length > 10) {
      console.log(chalk.dim(`  ... and ${uncommittedChanges.length - 10} more`));
    }
  }
  
  console.log();
  
  // Ask what to do
  let action: string;
  if (options.auto) {
    action = 'incorporate';
  } else {
    const { selectedAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedAction',
        message: 'How would you like to handle this drift?',
        choices: [
          {
            name: 'Incorporate - Update state to acknowledge these changes',
            value: 'incorporate',
          },
          {
            name: 'Ignore - Keep current state, changes are not relevant',
            value: 'ignore',
          },
          {
            name: 'Review - Show me more details first',
            value: 'review',
          },
        ],
      },
    ]);
    action = selectedAction;
  }
  
  if (action === 'review') {
    await showDetailedDrift(drift.changedFiles, uncommittedChanges, state);
    return;
  }
  
  if (action === 'ignore') {
    console.log(chalk.dim('Drift ignored. State unchanged.\n'));
    return;
  }
  
  // Incorporate changes
  const spinner = ora('Incorporating changes...').start();
  
  try {
    // Update base commit to current
    const newBaseCommit = await getBaseCommit();
    state.git_base_commit = newBaseCommit;
    state.updated_at = new Date().toISOString();
    
    // Log the drift
    const driftLogPath = path.join(getProjectPhasesDir(), 'logs', 'drift.log');
    const logEntry = `
[${new Date().toISOString()}]
Phase: ${state.current_phase}
Files changed: ${drift.changedFiles.length}
New commits: ${drift.newCommits}
Uncommitted: ${uncommittedChanges.length}
Action: incorporated
Files: ${[...drift.changedFiles, ...uncommittedChanges].join(', ')}
---
`;
    
    await fs.ensureDir(path.dirname(driftLogPath));
    await fs.appendFile(driftLogPath, logEntry);
    
    // Save updated state
    await saveProjectState(state);
    
    spinner.succeed('Changes incorporated!');
    
    console.log(chalk.green('\n✓ State updated to reflect external changes.'));
    console.log(chalk.dim('Drift logged to: .ai-phases/logs/drift.log\n'));
    
    // Suggest adding a note to current phase
    const currentPhase = await loadPhaseState(state.current_phase);
    if (currentPhase) {
      console.log(chalk.dim('Consider noting these changes in the current phase handover.'));
      console.log(chalk.cyan(`  ai-phases handover --phase ${state.current_phase}\n`));
    }
    
  } catch (error) {
    spinner.fail('Failed to incorporate changes');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  }
}

async function showDetailedDrift(
  changedFiles: string[],
  uncommittedChanges: string[],
  state: any
): Promise<void> {
  console.log(chalk.cyan('\n━━━ Detailed Drift Report ━━━\n'));
  
  // Categorize changes
  const categories: Record<string, string[]> = {
    'Source Code': [],
    'Configuration': [],
    'Documentation': [],
    'AI Phases': [],
    'Other': [],
  };
  
  const allFiles = [...new Set([...changedFiles, ...uncommittedChanges])];
  
  for (const file of allFiles) {
    if (file.startsWith('.ai-phases/')) {
      categories['AI Phases'].push(file);
    } else if (file.match(/\.(ts|tsx|js|jsx|py|go|rs|java)$/)) {
      categories['Source Code'].push(file);
    } else if (file.match(/\.(json|yaml|yml|toml|env|config)/)) {
      categories['Configuration'].push(file);
    } else if (file.match(/\.(md|txt|doc)/)) {
      categories['Documentation'].push(file);
    } else {
      categories['Other'].push(file);
    }
  }
  
  for (const [category, files] of Object.entries(categories)) {
    if (files.length > 0) {
      console.log(chalk.white(`${category} (${files.length}):`));
      files.forEach(f => console.log(chalk.dim(`  • ${f}`)));
      console.log();
    }
  }
  
  // Show impact on current phase
  const currentPhase = await loadPhaseState(state.current_phase);
  if (currentPhase) {
    console.log(chalk.white('Current Phase Context:'));
    console.log(chalk.dim(`  Phase ${currentPhase.phase_number}: ${currentPhase.name}`));
    console.log(chalk.dim(`  Status: ${currentPhase.status}`));
    console.log(chalk.dim(`  These changes may affect the phase execution.\n`));
  }
  
  // Options after review
  const { nextAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'nextAction',
      message: 'What would you like to do?',
      choices: [
        { name: 'Incorporate changes', value: 'incorporate' },
        { name: 'Ignore changes', value: 'ignore' },
        { name: 'Exit', value: 'exit' },
      ],
    },
  ]);
  
  if (nextAction === 'incorporate') {
    await syncCommand({ auto: true });
  } else if (nextAction === 'ignore') {
    console.log(chalk.dim('\nDrift ignored. State unchanged.\n'));
  }
}
