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
    version: '1.1.0',
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
  
  const isWindows = process.platform === 'win32';
  
  if (!cliStatus.installed) {
    console.log(chalk.red('  ✗ Cursor CLI (agent) not found\n'));
    
    if (isWindows) {
      console.log(chalk.white('  Install options for Windows:\n'));
      console.log(chalk.white('  Option 1 - WSL (recommended):'));
      console.log(chalk.dim('    1. Install WSL: ') + chalk.cyan('wsl --install'));
      console.log(chalk.dim('    2. Restart your computer'));
      console.log(chalk.dim('    3. Open WSL terminal and run:'));
      console.log(chalk.cyan('       curl https://cursor.com/install -fsS | bash'));
      console.log(chalk.dim('    4. Add to PATH:'));
      console.log(chalk.cyan('       echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc'));
      console.log();
      console.log(chalk.white('  Option 2 - Git Bash:'));
      console.log(chalk.dim('    1. Open Git Bash and run:'));
      console.log(chalk.cyan('       curl https://cursor.com/install -fsS | bash\n'));
    } else {
      console.log(chalk.white('  Install with:'));
      console.log(chalk.cyan('    curl https://cursor.com/install -fsS | bash'));
      console.log(chalk.dim('\n  Then add to PATH:'));
      console.log(chalk.cyan('    echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc'));
      console.log(chalk.cyan('    source ~/.bashrc\n'));
    }
    
    console.log(chalk.dim('  Docs: https://cursor.com/docs/cli/installation\n'));
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
      console.log(chalk.dim('\nSetup cancelled. Install Cursor CLI first, then run:'));
      console.log(chalk.cyan('  ai-phases config --setup\n'));
      process.exit(1);
    }
  } else if (!cliStatus.authenticated) {
    console.log(chalk.green('  ✓ Cursor CLI (agent) installed'));
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
        console.log(chalk.yellow('\nYou can login later with: agent login\n'));
      }
    } else {
      console.log(chalk.yellow('\nLogin later with: agent login\n'));
    }
  } else {
    console.log(chalk.green('  ✓ Cursor CLI (agent) installed'));
    console.log(chalk.green('  ✓ Logged in to Cursor'));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  }

  // GitHub Version Control Setup
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow('  GitHub Integration\n'));
  console.log(chalk.dim('  This enables auto repo creation and auto-push after each phase.\n'));
  
  const githubAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'use_github',
      message: 'Do you want to use GitHub for version control?',
      default: true,
    },
  ]);
  
  let githubReady = false;
  
  if (githubAnswer.use_github) {
    // Check GitHub CLI
    let ghStatus = await checkGitHubCliStatus();
    
    if (!ghStatus.installed) {
      console.log(chalk.red('\n  ✗ GitHub CLI (gh) not found\n'));
      
      // Check which package manager is available on Windows
      let installOptions: { name: string; value: string }[] = [];
      
      if (isWindows) {
        const hasWinget = await isCommandAvailable('winget');
        const hasChoco = await isCommandAvailable('choco');
        const hasScoop = await isCommandAvailable('scoop');
        
        if (hasWinget) {
          installOptions.push({ name: 'Install with winget (winget install --id GitHub.cli -e)', value: 'winget install --id GitHub.cli -e' });
        }
        if (hasChoco) {
          installOptions.push({ name: 'Install with Chocolatey (choco install gh)', value: 'choco install gh -y' });
        }
        if (hasScoop) {
          installOptions.push({ name: 'Install with Scoop (scoop install gh)', value: 'scoop install gh' });
        }
        
        if (installOptions.length === 0) {
          // No package manager found - show manual install instructions
          console.log(chalk.white('  No package manager found (winget, choco, scoop).\n'));
          console.log(chalk.white('  Please install GitHub CLI manually:'));
          console.log(chalk.cyan('  1. Download from: https://cli.github.com/'));
          console.log(chalk.cyan('  2. Run the installer'));
          console.log(chalk.cyan('  3. Restart your terminal'));
          console.log(chalk.cyan('  4. Run: ai-phases config --setup\n'));
          
          const manualInstallAnswer = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: 'How would you like to proceed?',
              choices: [
                { name: 'Open download page in browser', value: 'open' },
                { name: 'Skip GitHub integration (set up later)', value: 'skip' },
                { name: 'Cancel setup', value: 'cancel' },
              ],
            },
          ]);
          
          if (manualInstallAnswer.action === 'cancel') {
            console.log(chalk.dim('\nSetup cancelled. Run again with: ai-phases config --setup\n'));
            process.exit(1);
          }
          
          if (manualInstallAnswer.action === 'open') {
            const { exec } = await import('child_process');
            exec('start https://cli.github.com/');
            console.log(chalk.cyan('\n  Browser opened to https://cli.github.com/'));
            console.log(chalk.yellow('  After installing, run: ai-phases config --setup\n'));
          }
          
          console.log(chalk.yellow('\n  ⚠️  GitHub features disabled. Enable later with: ai-phases config --setup\n'));
        }
      } else if (process.platform === 'darwin') {
        const hasBrew = await isCommandAvailable('brew');
        if (hasBrew) {
          installOptions.push({ name: 'Install with Homebrew (brew install gh)', value: 'brew install gh' });
        }
      } else {
        // Linux
        const hasApt = await isCommandAvailable('apt');
        const hasDnf = await isCommandAvailable('dnf');
        
        if (hasApt) {
          installOptions.push({ name: 'Install with apt (sudo apt install gh)', value: 'sudo apt install gh -y' });
        }
        if (hasDnf) {
          installOptions.push({ name: 'Install with dnf (sudo dnf install gh)', value: 'sudo dnf install gh -y' });
        }
      }
      
      // If we have install options, show them
      if (installOptions.length > 0) {
        installOptions.push({ name: 'Skip GitHub integration (set up later)', value: 'skip' });
        installOptions.push({ name: 'Cancel setup', value: 'cancel' });
        
        const ghInstallChoice = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'How would you like to install GitHub CLI?',
            choices: installOptions,
          },
        ]);
        
        if (ghInstallChoice.action === 'cancel') {
          console.log(chalk.dim('\nSetup cancelled. Run again with: ai-phases config --setup\n'));
          process.exit(1);
        }
        
        if (ghInstallChoice.action !== 'skip') {
          const installSpinner = ora('Installing GitHub CLI...').start();
          const installSuccess = await runGitHubCliInstall(ghInstallChoice.action);
          
          if (installSuccess) {
            installSpinner.succeed('GitHub CLI installed!');
            // Re-check status
            ghStatus = await checkGitHubCliStatus();
            
            if (ghStatus.installed) {
              console.log(chalk.green('  ✓ GitHub CLI (gh) installed'));
              
              // Now authenticate
              if (!ghStatus.authenticated) {
                console.log(chalk.yellow('  ✗ Not authenticated with GitHub\n'));
                console.log(chalk.white('  You need to authenticate to enable auto repo creation.'));
                console.log(chalk.dim('  This will open your browser to sign in.\n'));
                
                const ghLoginAnswer = await inquirer.prompt([
                  {
                    type: 'confirm',
                    name: 'login_now',
                    message: 'Login to GitHub now?',
                    default: true,
                  },
                ]);
                
                if (ghLoginAnswer.login_now) {
                  const ghLoginSpinner = ora('Opening browser for GitHub login...').start();
                  const ghLoginSuccess = await runGitHubLogin();
                  
                  if (ghLoginSuccess) {
                    ghLoginSpinner.succeed('Logged in to GitHub!');
                    ghStatus = await checkGitHubCliStatus();
                    if (ghStatus.authenticated) {
                      githubReady = true;
                    }
                  } else {
                    ghLoginSpinner.fail('GitHub login failed or was cancelled');
                    console.log(chalk.yellow('\nYou can login later with: gh auth login\n'));
                  }
                }
              } else {
                console.log(chalk.green('  ✓ Authenticated with GitHub'));
                githubReady = true;
              }
            }
          } else {
            installSpinner.fail('GitHub CLI installation failed');
            console.log(chalk.yellow('\n  Try installing manually from: ') + chalk.cyan('https://cli.github.com/'));
            console.log(chalk.yellow('\n  GitHub features will be disabled for now.\n'));
          }
        } else {
          // User chose to skip
          console.log(chalk.yellow('\n  ⚠️  GitHub features disabled. Enable later with: ai-phases config --setup\n'));
        }
      }
    } else {
      console.log(chalk.green('\n  ✓ GitHub CLI (gh) installed'));
      
      if (!ghStatus.authenticated) {
        console.log(chalk.yellow('  ✗ Not authenticated with GitHub\n'));
        console.log(chalk.white('  You need to authenticate to enable auto repo creation.'));
        console.log(chalk.dim('  This will open your browser to sign in.\n'));
        
        const ghLoginAnswer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'login_now',
            message: 'Login to GitHub now?',
            default: true,
          },
        ]);
        
        if (ghLoginAnswer.login_now) {
          const ghLoginSpinner = ora('Opening browser for GitHub login...').start();
          const ghLoginSuccess = await runGitHubLogin();
          
          if (ghLoginSuccess) {
            ghLoginSpinner.succeed('Logged in to GitHub!');
            ghStatus = await checkGitHubCliStatus(); // Re-check status
            if (ghStatus.authenticated) {
              githubReady = true;
            }
          } else {
            ghLoginSpinner.fail('GitHub login failed or was cancelled');
            console.log(chalk.yellow('\nYou can login later with: gh auth login'));
            console.log(chalk.yellow('GitHub features will be disabled until authenticated.\n'));
          }
        } else {
          console.log(chalk.yellow('\nLogin later with: gh auth login'));
          console.log(chalk.yellow('GitHub features will be disabled until authenticated.\n'));
        }
      } else {
        console.log(chalk.green('  ✓ Authenticated with GitHub'));
        githubReady = true;
      }
    }
  } else {
    console.log(chalk.dim('\n  GitHub integration skipped. You can enable later with: ai-phases config --setup\n'));
  }
  
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

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
  
  // Build prompts dynamically based on GitHub status
  const automationPrompts: any[] = [
    {
      type: 'confirm',
      name: 'auto_run_phases',
      message: 'Auto-run ALL phases after planning? (fully hands-off)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'auto_commit',
      message: 'Auto-commit after each phase?',
      default: true,
    },
  ];
  
  // Only show GitHub options if GitHub is set up
  if (githubReady) {
    automationPrompts.push(
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
        when: (promptAnswers: any) => promptAnswers.auto_create_repo,
      },
      {
        type: 'confirm',
        name: 'auto_push',
        message: 'Auto-push to remote after each phase?',
        default: true,
        when: (promptAnswers: any) => promptAnswers.auto_commit,
      }
    );
  }
  
  const automation = await inquirer.prompt<{
    auto_run_phases: boolean;
    auto_create_repo?: boolean;
    github_visibility?: 'private' | 'public';
    auto_commit: boolean;
    auto_push?: boolean;
  }>(automationPrompts);

  const config: GlobalConfig = {
    version: '1.6.3',
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
      auto_push: githubReady ? (automation.auto_push ?? true) : false,
      auto_run_phases: automation.auto_run_phases,
      auto_create_repo: githubReady ? (automation.auto_create_repo ?? true) : false,
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

interface GhCliStatus {
  installed: boolean;
  authenticated: boolean;
}

// On Windows, run cursor-agent through WSL Ubuntu
const isWindows = process.platform === 'win32';

/**
 * Check if a command is available in the system
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    // Use 'where' on Windows, 'which' on Unix
    const checkCmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
    await execAsync(checkCmd, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if GitHub CLI (gh) is installed and authenticated
 */
async function checkGitHubCliStatus(): Promise<GhCliStatus> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    // Check if gh is installed
    await execAsync('gh --version', { timeout: 5000 });
  } catch {
    return { installed: false, authenticated: false };
  }
  
  try {
    // Check if authenticated
    await execAsync('gh auth status', { timeout: 5000 });
    return { installed: true, authenticated: true };
  } catch {
    return { installed: true, authenticated: false };
  }
}

/**
 * Run gh auth login (opens browser)
 */
async function runGitHubLogin(): Promise<boolean> {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    // gh auth login with web browser flow
    const child = spawn('gh', ['auth', 'login', '--web', '-h', 'github.com'], {
      stdio: 'inherit', // Show login process to user
    });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
    
    child.on('error', () => {
      resolve(false);
    });
    
    // Timeout after 3 minutes
    setTimeout(() => {
      child.kill();
      resolve(false);
    }, 180000);
  });
}

/**
 * Install GitHub CLI using system package manager
 */
async function runGitHubCliInstall(command: string): Promise<boolean> {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    // Parse the command
    const parts = command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);
    
    const child = spawn(cmd, args, {
      stdio: 'inherit', // Show install progress to user
      shell: true,
    });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
    
    child.on('error', () => {
      resolve(false);
    });
    
    // Timeout after 5 minutes for installation
    setTimeout(() => {
      child.kill();
      resolve(false);
    }, 300000);
  });
}

function getCursorAgentVersionCmd(): string {
  if (isWindows) {
    return 'wsl -d Ubuntu -e bash -c "/root/.local/bin/cursor-agent --version"';
  }
  return 'cursor-agent --version';
}

/**
 * Check if Cursor CLI (agent) is installed and authenticated
 * CLI docs: https://cursor.com/docs/cli/installation
 */
async function checkCursorCliStatus(): Promise<CliStatus> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    // Check if CLI is installed - the command is 'cursor-agent'
    await execAsync(getCursorAgentVersionCmd(), { timeout: 10000 });
  } catch {
    return { installed: false, authenticated: false };
  }
  
  // If agent --version works, CLI is installed
  // Authentication is handled per-request by the agent
  return { installed: true, authenticated: true };
}

/**
 * Run agent login (opens browser)
 * CLI docs: https://cursor.com/docs/cli/installation
 */
async function runCursorLogin(): Promise<boolean> {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    let child;
    if (isWindows) {
      child = spawn('wsl', ['-d', 'Ubuntu', '-e', 'bash', '-c', '/root/.local/bin/cursor-agent login'], {
        stdio: 'inherit', // Show login process to user
      });
    } else {
      child = spawn('cursor-agent', ['login'], {
        stdio: 'inherit', // Show login process to user
      });
    }
    
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
