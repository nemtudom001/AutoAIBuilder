import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import boxen from 'boxen';

export interface GlobalConfig {
  version: string;
  setup_complete: boolean;
  cursor: {
    enabled: boolean;
    planning_model: string;
    execution_model: string;
    context7_enabled: boolean;
  };
  defaults: {
    ui_library: string;
    design_system: string;
    auto_commit: boolean;
    max_retry_attempts: number;
  };
}

export interface ProjectConfig {
  project_name: string;
  created_at: string;
  ui_library: string;
  design_system: string;
  total_phases: number;
  current_phase: number;
  current_attempt: number;
  status: 'planning' | 'in_progress' | 'completed' | 'blocked';
}

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.ai-phase-builder');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'config.json');
const PROJECT_CONFIG_DIR = '.ai-phases';
const PROJECT_CONFIG_FILE = path.join(PROJECT_CONFIG_DIR, 'config.json');

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_FILE;
}

export function getProjectConfigPath(): string {
  return path.join(process.cwd(), PROJECT_CONFIG_FILE);
}

export function getProjectPhasesDir(): string {
  return path.join(process.cwd(), PROJECT_CONFIG_DIR);
}

export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  try {
    if (await fs.pathExists(GLOBAL_CONFIG_FILE)) {
      return await fs.readJson(GLOBAL_CONFIG_FILE);
    }
  } catch {
    // Config doesn't exist or is invalid
  }
  return null;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await fs.ensureDir(GLOBAL_CONFIG_DIR);
  await fs.writeJson(GLOBAL_CONFIG_FILE, config, { spaces: 2 });
}

export async function loadProjectConfig(): Promise<ProjectConfig | null> {
  try {
    const configPath = getProjectConfigPath();
    if (await fs.pathExists(configPath)) {
      return await fs.readJson(configPath);
    }
  } catch {
    // Config doesn't exist or is invalid
  }
  return null;
}

export async function saveProjectConfig(config: ProjectConfig): Promise<void> {
  const configPath = getProjectConfigPath();
  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJson(configPath, config, { spaces: 2 });
}

export function getDefaultGlobalConfig(): GlobalConfig {
  return {
    version: '1.0.0',
    setup_complete: false,
    cursor: {
      enabled: true,
      planning_model: 'claude-opus-4.5',
      execution_model: 'gemini-3-flash',
      context7_enabled: false,
    },
    defaults: {
      ui_library: 'shadcn',
      design_system: 'vercel',
      auto_commit: true,
      max_retry_attempts: 3,
    },
  };
}

export async function ensureGlobalConfig(): Promise<boolean> {
  const config = await loadGlobalConfig();
  
  if (!config || !config.setup_complete) {
    return true; // First run
  }
  
  return false;
}

export async function runSetupWizard(): Promise<GlobalConfig> {
  console.log(
    boxen(
      chalk.bold.cyan('🚀 AI Phase Builder - First Time Setup') +
      '\n\n' +
      chalk.white('Works seamlessly with your Cursor subscription.') +
      '\n' +
      chalk.dim('Zero API keys required!'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'cyan',
      }
    )
  );

  console.log(chalk.white('\nThis tool orchestrates AI-powered development in Cursor:\n'));
  console.log(chalk.green('  ✓ Claude Opus    ') + chalk.dim('→ Planning & reasoning'));
  console.log(chalk.green('  ✓ Gemini Flash   ') + chalk.dim('→ Coding & execution'));
  console.log(chalk.green('  ✓ Context7 MCP   ') + chalk.dim('→ Documentation lookup (free)\n'));

  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'context7_enabled',
      message: 'Is Context7 MCP enabled in your Cursor?',
      default: true,
    },
  ]);

  if (!answers.context7_enabled) {
    console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.yellow('  How to enable Context7:\n'));
    console.log(chalk.white('  1. Open Cursor Settings (Cmd+,)'));
    console.log(chalk.white('  2. Go to: Features → MCP Servers'));
    console.log(chalk.white('  3. Add Context7: ') + chalk.cyan('https://context7.com/docs/clients/cursor'));
    console.log(chalk.white('  4. Restart Cursor'));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    const continueAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continue',
        message: 'Continue setup anyway? (You can enable Context7 later)',
        default: true,
      },
    ]);

    if (!continueAnswer.continue) {
      console.log(chalk.dim('\nSetup cancelled. Run ') + chalk.cyan('ai-phases config --setup') + chalk.dim(' when ready.\n'));
      process.exit(0);
    }
  }

  // Default preferences
  const preferences = await inquirer.prompt([
    {
      type: 'list',
      name: 'ui_library',
      message: 'Default UI library:',
      choices: ['shadcn', 'radix', 'chakra', 'none'],
      default: 'shadcn',
    },
    {
      type: 'list',
      name: 'design_system',
      message: 'Default design principles:',
      choices: ['vercel', 'apple', 'material', 'custom'],
      default: 'vercel',
    },
    {
      type: 'confirm',
      name: 'auto_commit',
      message: 'Auto-commit after each phase?',
      default: true,
    },
  ]);

  const config: GlobalConfig = {
    version: '1.0.0',
    setup_complete: true,
    cursor: {
      enabled: true,
      planning_model: 'claude-opus-4.5',
      execution_model: 'gemini-3-flash',
      context7_enabled: answers.context7_enabled,
    },
    defaults: {
      ui_library: preferences.ui_library,
      design_system: preferences.design_system,
      auto_commit: preferences.auto_commit,
      max_retry_attempts: 3,
    },
  };

  await saveGlobalConfig(config);

  console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.green.bold('  ✅ Setup Complete!'));
  console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  console.log(chalk.dim('Configuration saved to: ') + chalk.white(GLOBAL_CONFIG_FILE));
  console.log(chalk.dim('\nModel routing (via Cursor):'));
  console.log(chalk.white('  • Planning phases  → ') + chalk.cyan('Claude Opus'));
  console.log(chalk.white('  • Coding phases    → ') + chalk.cyan('Gemini Flash'));
  console.log(chalk.white('  • Documentation    → ') + chalk.cyan('Context7 MCP\n'));

  console.log(chalk.green('🎉 Ready! Try:\n'));
  console.log(chalk.cyan('  ai-phases refine "your project idea"\n'));

  return config;
}

export async function showConfig(): Promise<void> {
  const config = await loadGlobalConfig();
  
  if (!config) {
    console.log(chalk.yellow('No configuration found. Run setup with: ai-phases config --setup'));
    return;
  }

  console.log(chalk.bold('\n📋 Current Configuration:\n'));
  console.log(chalk.dim('Global config: ') + chalk.white(GLOBAL_CONFIG_FILE));
  console.log();
  console.log(chalk.white('Cursor Integration:'));
  console.log(chalk.dim('  Planning model:  ') + chalk.cyan(config.cursor.planning_model));
  console.log(chalk.dim('  Execution model: ') + chalk.cyan(config.cursor.execution_model));
  console.log(chalk.dim('  Context7 MCP:    ') + (config.cursor.context7_enabled ? chalk.green('enabled') : chalk.yellow('disabled')));
  console.log();
  console.log(chalk.white('Defaults:'));
  console.log(chalk.dim('  UI library:      ') + chalk.white(config.defaults.ui_library));
  console.log(chalk.dim('  Design system:   ') + chalk.white(config.defaults.design_system));
  console.log(chalk.dim('  Auto-commit:     ') + (config.defaults.auto_commit ? chalk.green('yes') : chalk.yellow('no')));
  console.log(chalk.dim('  Max retries:     ') + chalk.white(config.defaults.max_retry_attempts.toString()));
  console.log();
}

export async function resetConfig(): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Reset all configuration to defaults?',
      default: false,
    },
  ]);

  if (answers.confirm) {
    const config = getDefaultGlobalConfig();
    config.setup_complete = true;
    await saveGlobalConfig(config);
    console.log(chalk.green('✓ Configuration reset to defaults.'));
  } else {
    console.log(chalk.dim('Reset cancelled.'));
  }
}
