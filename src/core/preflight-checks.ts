import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// On Windows, run commands through WSL Ubuntu
const isWindows = process.platform === 'win32';

/**
 * Convert Windows path to WSL path (C:\Users\... -> /mnt/c/Users/...)
 */
function toWslPath(windowsPath: string): string {
  if (!isWindows) return windowsPath;
  return windowsPath
    .replace(/^([A-Z]):/i, (_, letter) => `/mnt/${letter.toLowerCase()}`)
    .replace(/\\/g, '/');
}

/**
 * Find the actual project directory (where package.json is)
 * Looks in current directory and common subdirectories
 */
async function findProjectDir(): Promise<string> {
  const cwd = process.cwd();
  
  // Check current directory first
  if (await fs.pathExists(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  
  // Check common subdirectories where AI might create projects
  const possibleDirs = ['web', 'app', 'frontend', 'client', 'src', 'project'];
  for (const dir of possibleDirs) {
    const fullPath = path.join(cwd, dir);
    if (await fs.pathExists(path.join(fullPath, 'package.json'))) {
      return fullPath;
    }
  }
  
  // Check any directory that has package.json
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const fullPath = path.join(cwd, entry.name);
        if (await fs.pathExists(path.join(fullPath, 'package.json'))) {
          return fullPath;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  
  return cwd;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
  criticalFailures: string[];
  warnings: string[];
}

export interface PreflightCheck {
  name: string;
  status: 'passed' | 'failed' | 'warning';
  message: string;
  fix?: string;
}

/**
 * Run pre-flight checks before executing a phase
 */
export async function runPreflightChecks(
  phaseNumber: number,
  uiLibrary: string
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const criticalFailures: string[] = [];
  const warnings: string[] = [];

  // Phase 1 doesn't need dependency checks (it sets them up)
  if (phaseNumber === 1) {
    return { passed: true, checks, criticalFailures, warnings };
  }

  // Find the actual project directory
  const projectDir = await findProjectDir();

  // Check package.json exists
  const packageJsonCheck = await checkPackageJson(projectDir);
  checks.push(packageJsonCheck);
  if (packageJsonCheck.status === 'failed') {
    criticalFailures.push(packageJsonCheck.message);
  }

  // Check node_modules exists
  const nodeModulesCheck = await checkNodeModules(projectDir);
  checks.push(nodeModulesCheck);
  if (nodeModulesCheck.status === 'failed') {
    criticalFailures.push(nodeModulesCheck.message);
  }

  // Check UI library specific requirements
  if (uiLibrary === 'shadcn') {
    const shadcnChecks = await checkShadcnSetup(projectDir);
    checks.push(...shadcnChecks);
    for (const check of shadcnChecks) {
      if (check.status === 'failed') {
        criticalFailures.push(check.message);
      } else if (check.status === 'warning') {
        warnings.push(check.message);
      }
    }
  }

  // Check TypeScript config
  const tsConfigCheck = await checkTypeScriptConfig(projectDir);
  checks.push(tsConfigCheck);
  if (tsConfigCheck.status === 'warning') {
    warnings.push(tsConfigCheck.message);
  }

  // Check if project builds
  if (criticalFailures.length === 0) {
    const buildCheck = await checkBuildWorks(projectDir);
    checks.push(buildCheck);
    if (buildCheck.status === 'failed') {
      criticalFailures.push(buildCheck.message);
    }
  }

  return {
    passed: criticalFailures.length === 0,
    checks,
    criticalFailures,
    warnings,
  };
}

async function checkPackageJson(projectDir: string): Promise<PreflightCheck> {
  const packageJsonPath = path.join(projectDir, 'package.json');
  
  if (await fs.pathExists(packageJsonPath)) {
    return {
      name: 'package.json',
      status: 'passed',
      message: `package.json exists (in ${path.basename(projectDir) || 'root'})`,
    };
  }
  
  return {
    name: 'package.json',
    status: 'failed',
    message: 'package.json not found - Phase 1 may not have completed properly',
    fix: 'Run Phase 1 again or create a new Next.js project with: npx create-next-app@latest',
  };
}

async function checkNodeModules(projectDir: string): Promise<PreflightCheck> {
  const nodeModulesPath = path.join(projectDir, 'node_modules');
  
  if (await fs.pathExists(nodeModulesPath)) {
    return {
      name: 'node_modules',
      status: 'passed',
      message: 'Dependencies installed',
    };
  }
  
  return {
    name: 'node_modules',
    status: 'failed',
    message: 'node_modules not found - dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkShadcnSetup(projectDir: string): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  
  // Check components.json exists
  const componentsJsonPath = path.join(projectDir, 'components.json');
  if (await fs.pathExists(componentsJsonPath)) {
    checks.push({
      name: 'shadcn/ui config',
      status: 'passed',
      message: 'components.json exists - shadcn/ui is configured',
    });
    
    // Read and validate components.json
    try {
      const config = await fs.readJson(componentsJsonPath);
      if (!config.aliases?.ui) {
        checks.push({
          name: 'shadcn/ui aliases',
          status: 'warning',
          message: 'shadcn/ui aliases may not be configured correctly',
          fix: 'Check components.json has proper aliases configured',
        });
      }
    } catch {
      checks.push({
        name: 'shadcn/ui config valid',
        status: 'warning',
        message: 'Could not parse components.json',
      });
    }
  } else {
    checks.push({
      name: 'shadcn/ui config',
      status: 'failed',
      message: 'components.json not found - shadcn/ui is NOT installed',
      fix: 'Run: npx shadcn@latest init',
    });
  }
  
  // Check if ui components directory exists
  const possibleUiPaths = [
    path.join(projectDir, 'components', 'ui'),
    path.join(projectDir, 'src', 'components', 'ui'),
  ];
  
  let uiDirExists = false;
  for (const uiPath of possibleUiPaths) {
    if (await fs.pathExists(uiPath)) {
      uiDirExists = true;
      
      // Check if button component exists (basic shadcn component)
      const buttonPath = path.join(uiPath, 'button.tsx');
      if (await fs.pathExists(buttonPath)) {
        checks.push({
          name: 'shadcn/ui Button',
          status: 'passed',
          message: 'Button component installed',
        });
      } else {
        checks.push({
          name: 'shadcn/ui Button',
          status: 'warning',
          message: 'Button component not found - may need to add components',
          fix: 'Run: npx shadcn@latest add button',
        });
      }
      break;
    }
  }
  
  if (!uiDirExists) {
    checks.push({
      name: 'shadcn/ui components dir',
      status: 'warning',
      message: 'UI components directory not found',
      fix: 'shadcn/ui components will be created when you add them: npx shadcn@latest add button',
    });
  }
  
  return checks;
}

async function checkTypeScriptConfig(projectDir: string): Promise<PreflightCheck> {
  const tsConfigPath = path.join(projectDir, 'tsconfig.json');
  
  if (await fs.pathExists(tsConfigPath)) {
    return {
      name: 'TypeScript config',
      status: 'passed',
      message: 'tsconfig.json exists',
    };
  }
  
  return {
    name: 'TypeScript config',
    status: 'warning',
    message: 'tsconfig.json not found - TypeScript may not be configured',
  };
}

async function checkBuildWorks(projectDir: string): Promise<PreflightCheck> {
  try {
    // Run npm run build through WSL on Windows for consistency
    let command = 'npm run build';
    let execOptions: any = {
      cwd: projectDir,
      timeout: 120000, // 2 minutes for build
    };
    
    if (isWindows) {
      const wslProjectDir = toWslPath(projectDir);
      command = `wsl -d Ubuntu -e bash -c "cd '${wslProjectDir}' && npm run build"`;
      execOptions.cwd = undefined;
    }
    
    await execAsync(command, execOptions);
    
    return {
      name: 'Build check',
      status: 'passed',
      message: 'npm run build completed successfully',
    };
  } catch (error: any) {
    const errorOutput = error.stderr || error.stdout || error.message || '';
    
    // Extract first error for display
    const firstError = errorOutput.split('\n').find((line: string) => 
      line.includes('error') || line.includes('Error:')
    ) || 'Build errors detected';
    
    return {
      name: 'Build check',
      status: 'failed',
      message: `Build failed: ${firstError.substring(0, 100)}`,
      fix: 'Fix build errors before proceeding. Run: npm run build to see all errors.',
    };
  }
}

/**
 * Display preflight results to console
 */
export function displayPreflightResults(result: PreflightResult): void {
  console.log(chalk.cyan('\n━━━ Pre-flight Checks ━━━\n'));
  
  for (const check of result.checks) {
    const icon = check.status === 'passed' ? chalk.green('✓') :
                 check.status === 'warning' ? chalk.yellow('⚠') :
                 chalk.red('✗');
    
    console.log(`${icon} ${check.name}: ${chalk.dim(check.message)}`);
    
    if (check.fix && check.status !== 'passed') {
      console.log(chalk.dim(`  Fix: ${check.fix}`));
    }
  }
  
  if (result.criticalFailures.length > 0) {
    console.log(chalk.red('\n⛔ Critical issues must be fixed before proceeding:\n'));
    result.criticalFailures.forEach(f => console.log(chalk.red(`  • ${f}`)));
  }
  
  if (result.warnings.length > 0 && result.passed) {
    console.log(chalk.yellow('\n⚠️  Warnings (proceeding anyway):\n'));
    result.warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
  }
  
  console.log();
}
