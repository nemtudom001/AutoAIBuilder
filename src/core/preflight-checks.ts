import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  // Check package.json exists
  const packageJsonCheck = await checkPackageJson();
  checks.push(packageJsonCheck);
  if (packageJsonCheck.status === 'failed') {
    criticalFailures.push(packageJsonCheck.message);
  }

  // Check node_modules exists
  const nodeModulesCheck = await checkNodeModules();
  checks.push(nodeModulesCheck);
  if (nodeModulesCheck.status === 'failed') {
    criticalFailures.push(nodeModulesCheck.message);
  }

  // Check UI library specific requirements
  if (uiLibrary === 'shadcn') {
    const shadcnChecks = await checkShadcnSetup();
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
  const tsConfigCheck = await checkTypeScriptConfig();
  checks.push(tsConfigCheck);
  if (tsConfigCheck.status === 'warning') {
    warnings.push(tsConfigCheck.message);
  }

  // Check if project builds
  if (criticalFailures.length === 0) {
    const buildCheck = await checkBuildWorks();
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

async function checkPackageJson(): Promise<PreflightCheck> {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  
  if (await fs.pathExists(packageJsonPath)) {
    return {
      name: 'package.json',
      status: 'passed',
      message: 'package.json exists',
    };
  }
  
  return {
    name: 'package.json',
    status: 'failed',
    message: 'package.json not found - Phase 1 may not have completed properly',
    fix: 'Run Phase 1 again or create a new Next.js project with: npx create-next-app@latest',
  };
}

async function checkNodeModules(): Promise<PreflightCheck> {
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  
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

async function checkShadcnSetup(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  
  // Check components.json exists
  const componentsJsonPath = path.join(process.cwd(), 'components.json');
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
    path.join(process.cwd(), 'components', 'ui'),
    path.join(process.cwd(), 'src', 'components', 'ui'),
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

async function checkTypeScriptConfig(): Promise<PreflightCheck> {
  const tsConfigPath = path.join(process.cwd(), 'tsconfig.json');
  
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

async function checkBuildWorks(): Promise<PreflightCheck> {
  try {
    // Run a quick type check instead of full build for speed
    await execAsync('npx tsc --noEmit --skipLibCheck', {
      cwd: process.cwd(),
      timeout: 60000,
    });
    
    return {
      name: 'TypeScript check',
      status: 'passed',
      message: 'No TypeScript errors detected',
    };
  } catch (error: any) {
    const errorOutput = error.stderr || error.stdout || error.message || '';
    
    // Extract first error for display
    const firstError = errorOutput.split('\n').find((line: string) => 
      line.includes('error TS') || line.includes('Error:')
    ) || 'TypeScript errors detected';
    
    return {
      name: 'TypeScript check',
      status: 'failed',
      message: `TypeScript errors exist: ${firstError.substring(0, 100)}`,
      fix: 'Fix TypeScript errors before proceeding. Run: npx tsc --noEmit to see all errors.',
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
