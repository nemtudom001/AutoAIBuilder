#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { initCommand } from './commands/init.js';
import { refineCommand } from './commands/refine.js';
import { planCommand } from './commands/plan.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { handoverCommand } from './commands/handover.js';
import { rollbackCommand } from './commands/rollback.js';
import { syncCommand } from './commands/sync.js';
import { configCommand } from './commands/config.js';
import { ensureGlobalConfig } from '../core/config-manager.js';

const program = new Command();

program
  .name('ai-phases')
  .description('AI-powered project phase orchestration for Cursor IDE')
  .version('1.0.2');

// Check for first-run setup
const isFirstRun = await ensureGlobalConfig();

if (isFirstRun && process.argv[2] !== 'config' && process.argv[2] !== '--help' && process.argv[2] !== '-h') {
  console.log(chalk.yellow('\n⚠️  First time setup required. Running setup wizard...\n'));
}

// Initialize command
program
  .command('init')
  .description('Initialize AI Phase Builder in current project')
  .option('--ui <library>', 'UI library (shadcn)', 'shadcn')
  .option('--design <system>', 'Design system (vercel)', 'vercel')
  .option('--from-idea <idea>', 'Initialize from a project idea')
  .option('-y, --yes', 'Non-interactive mode, use defaults')
  .action(initCommand);

// Refine command - the magic prompt enhancement chain
program
  .command('refine')
  .description('Enhance your idea and structure it into phases')
  .argument('<idea>', 'Your project idea (in quotes)')
  .option('--skip-research', 'Skip documentation lookup stage')
  .option('--no-auto-run', 'Skip auto-running phases (just generate plan)')
  .action(refineCommand);

// Plan command - manual phase planning
program
  .command('plan')
  .description('Manually create or edit phase plan')
  .option('--interactive', 'Interactive guided planning')
  .option('--from-readme', 'Infer phases from existing README')
  .action(planCommand);

// Run command - execute a phase
program
  .command('run')
  .description('Execute a specific phase')
  .option('--phase <number>', 'Phase number to run')
  .option('--dry-run', 'Show prompt without executing')
  .option('--auto', 'Auto-proceed without confirmations')
  .action(runCommand);

// Status command - show current state
program
  .command('status')
  .description('Show current project phase status')
  .option('--verbose', 'Show detailed information')
  .action(statusCommand);

// Handover command - generate handover summary
program
  .command('handover')
  .description('Generate handover summary for current/specified phase')
  .option('--phase <number>', 'Phase number')
  .option('--summarize', 'Compress context for next phase')
  .action(handoverCommand);

// Rollback command - revert failed phase
program
  .command('rollback')
  .description('Rollback a failed phase to retry')
  .option('--phase <number>', 'Phase number to rollback')
  .action(rollbackCommand);

// Sync command - detect drift from manual edits
program
  .command('sync')
  .description('Detect and reconcile manual changes')
  .option('--auto', 'Auto-incorporate changes without prompting')
  .action(syncCommand);

// Config command - manage configuration
program
  .command('config')
  .description('Manage AI Phase Builder configuration')
  .option('--setup', 'Run setup wizard')
  .option('--show', 'Show current configuration')
  .option('--reset', 'Reset to defaults')
  .action(configCommand);

program.parse();
