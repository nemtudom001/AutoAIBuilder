import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import boxen from 'boxen';
import ora from 'ora';

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
    auto_push: boolean;
    auto_run_phases: boolean;
    auto_create_repo: boolean;
    github_visibility: 'private' | 'public';
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
    version: '1.0.4',
    setup_complete: false,
    cursor: {
      enabled: true,
      planning_model: 'opus-4.5',
      execution_model: 'gemini-3-flash',
      context7_enabled: false,
    },
    defaults: {
      ui_library: 'shadcn',
      design_system: 'vercel',
      auto_commit: true,
      auto_push: true,
      auto_run_phases: true,
      auto_create_repo: true,
      github_visibility: 'private',
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
      chalk.white('Fully automated development with Cursor CLI.') +
      '\n' +
      chalk.dim('Uses your Cursor subscription - no external API keys!'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'cyan',
      }
    )
  );

  console.log(chalk.white('\nThis tool orchestrates AI-powered development via Cursor CLI:\n'));
  console.log(chalk.green('  ✓ Claude Opus    ') + chalk.dim('→ Planning & reasoning'));
  console.log(chalk.green('  ✓ Gemini Flash   ') + chalk.dim('→ Coding & execution'));
  console.log(chalk.green('  ✓ Context7 MCP   ') + chalk.dim('→ Documentation lookup (free)'));
  console.log(chalk.green('  ✓ Full Automation') + chalk.dim('→ No manual prompts or copy-paste\n'));

  // Check Cursor CLI installation and authentication
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow('  Cursor CLI Setup\n'));
  
  const cliStatus = await checkCursorCliStatus();
  
  if (!cliStatus.installed) {
    console.log(chalk.red('  ✗ cursor-agent CLI not found\n'));
    console.log(chalk.white('  Install it with:'));
    console.log(chalk.cyan('    curl https://cursor.com/install -fsS | bash\n'));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    const continueAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continue_anyway',
        message: 'Continue setup anyway? (install CLI later)',
        default: false,
      },
    ]);
    
    if (!continueAnswer.continue_anyway) {
      console.log(chalk.dim('\nSetup cancelled. Install cursor-agent first, then run:'));
      console.log(chalk.cyan('  ai-phases config --setup\n'));
      process.exit(1);
    }
  } else if (!cliStatus.authenticated) {
    console.log(chalk.green('  ✓ cursor-agent CLI installed'));
    console.log(chalk.yellow('  ✗ Not logged in\n'));
    console.log(chalk.white('  You need to authenticate with Cursor.'));
    console.log(chalk.dim('  This will open your browser to sign in.\n'));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    const loginAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'login_now',
        message: 'Login to Cursor now?',
        default: true,
      },
    ]);
    
    if (loginAnswer.login_now) {
      const loginSpinner = ora('Opening browser for Cursor login...').start();
      const loginSuccess = await runCursorLogin();
      
      if (loginSuccess) {
        loginSpinner.succeed('Logged in to Cursor!');
      } else {
        loginSpinner.fail('Login failed or was cancelled');
        console.log(chalk.yellow('\nYou can login later with: cursor-agent login\n'));
      }
    } else {
      console.log(chalk.yellow('\nLogin later with: cursor-agent login\n'));
    }
  } else {
    console.log(chalk.green('  ✓ cursor-agent CLI installed'));
    console.log(chalk.green('  ✓ Logged in to Cursor'));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  }

  // Context7 check
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
  ]);

  // Automation preferences
  console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow('  Automation Settings\n'));
  
  const automation = await inquirer.prompt<{
    auto_run_phases: boolean;
    auto_create_repo: boolean;
    github_visibility?: 'private' | 'public';
    auto_commit: boolean;
    auto_push?: boolean;
  }>([
    {
      type: 'confirm',
      name: 'auto_run_phases',
      message: 'Auto-run ALL phases after planning? (fully hands-off)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'auto_create_repo',
      message: 'Auto-create GitHub repo for new projects?',
      default: true,
    },
    {
      type: 'list',
      name: 'github_visibility',
      message: 'Default repo visibility:',
      choices: ['private', 'public'],
      default: 'private',
      when: (answers) => answers.auto_create_repo,
    },
    {
      type: 'confirm',
      name: 'auto_commit',
      message: 'Auto-commit after each phase?',
      default: true,
    },
    {
      type: 'confirm',
      name: 'auto_push',
      message: 'Auto-push to remote after each phase?',
      default: true,
      when: (answers) => answers.auto_commit,
    },
  ]);

  const config: GlobalConfig = {
    version: '1.0.4',
    setup_complete: true,
    cursor: {
      enabled: true,
      planning_model: 'opus-4.5',
      execution_model: 'gemini-3-flash',
      context7_enabled: answers.context7_enabled,
    },
    defaults: {
      ui_library: preferences.ui_library,
      design_system: preferences.design_system,
      auto_commit: automation.auto_commit,
      auto_push: automation.auto_push ?? true,
      auto_run_phases: automation.auto_run_phases,
      auto_create_repo: automation.auto_create_repo,
      github_visibility: automation.github_visibility ?? 'private',
      max_retry_attempts: 3,
    },
  };

  await saveGlobalConfig(config);

  console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.green.bold('  ✅ Setup Complete!'));
  console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  console.log(chalk.dim('Configuration saved to: ') + chalk.white(GLOBAL_CONFIG_FILE));
  console.log(chalk.dim('\nModel routing (via Cursor CLI):'));
  console.log(chalk.white('  • Planning phases  → ') + chalk.cyan('Claude Opus'));
  console.log(chalk.white('  • Coding phases    → ') + chalk.cyan('Gemini Flash'));
  console.log(chalk.white('  • Documentation    → ') + chalk.cyan('Context7 MCP'));
  console.log(chalk.white('  • Execution        → ') + chalk.cyan('Fully automated\n'));

  console.log(chalk.green('🎉 Ready! Try:\n'));
  console.log(chalk.cyan('  ai-phases refine "your project idea"\n'));

  return config;
}

interface CliStatus {
  installed: boolean;
  authenticated: boolean;
}

/**
 * Check if cursor-agent is installed and authenticated
 */
async function checkCursorCliStatus(): Promise<CliStatus> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    // Check if CLI is installed
    await execAsync('cursor-agent --version', { timeout: 5000 });
  } catch {
    return { installed: false, authenticated: false };
  }
  
  try {
    // Check authentication status
    const { stdout } = await execAsync('cursor-agent status', { timeout: 10000 });
    // If status returns successfully and contains user info, we're authenticated
    const isAuthenticated = stdout.toLowerCase().includes('logged in') || 
                           stdout.toLowerCase().includes('authenticated') ||
                           stdout.includes('@'); // Usually shows email when logged in
    return { installed: true, authenticated: isAuthenticated };
  } catch {
    // Status command failed, might not be authenticated
    return { installed: true, authenticated: false };
  }
}

/**
 * Run cursor-agent login (opens browser)
 */
async function runCursorLogin(): Promise<boolean> {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    const child = spawn('cursor-agent', ['login'], {
      stdio: 'inherit', // Show login process to user
    });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
    
    child.on('error', () => {
      resolve(false);
    });
    
    // Timeout after 2 minutes
    setTimeout(() => {
      child.kill();
      resolve(false);
    }, 120000);
  });
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
