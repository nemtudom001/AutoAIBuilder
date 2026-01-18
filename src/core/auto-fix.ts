import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface AutoFixResult {
  fixed: boolean;
  fixesApplied: string[];
  remainingErrors: string[];
  suggestions: string[];
}

/**
 * Attempt to auto-fix common build errors
 */
export async function attemptAutoFix(errorOutput: string): Promise<AutoFixResult> {
  const fixesApplied: string[] = [];
  const suggestions: string[] = [];
  let remainingErrors: string[] = [];

  // Parse error output
  const errors = parseErrors(errorOutput);
  remainingErrors = [...errors];

  // Try to fix each error type
  for (const error of errors) {
    const fixResult = await tryFixError(error);
    
    if (fixResult.fixed) {
      fixesApplied.push(fixResult.description);
      remainingErrors = remainingErrors.filter(e => e !== error);
    } else if (fixResult.suggestion) {
      suggestions.push(fixResult.suggestion);
    }
  }

  return {
    fixed: fixesApplied.length > 0,
    fixesApplied,
    remainingErrors,
    suggestions,
  };
}

interface ParsedError {
  type: 'typescript' | 'module' | 'syntax' | 'tailwind' | 'eslint' | 'unknown';
  file?: string;
  line?: number;
  message: string;
  code?: string;
}

function parseErrors(errorOutput: string): string[] {
  const errors: string[] = [];
  const lines = errorOutput.split('\n');
  
  for (const line of lines) {
    // TypeScript errors
    if (line.includes('error TS') || line.includes('Type error:')) {
      errors.push(line);
    }
    // Module not found
    if (line.includes('Cannot find module') || line.includes('Module not found')) {
      errors.push(line);
    }
    // Syntax errors
    if (line.includes('SyntaxError') || line.includes('Unexpected token')) {
      errors.push(line);
    }
    // Tailwind errors
    if (line.includes('Unknown utility class') || line.includes('Cannot apply')) {
      errors.push(line);
    }
  }
  
  return [...new Set(errors)]; // Remove duplicates
}

interface FixAttemptResult {
  fixed: boolean;
  description: string;
  suggestion?: string;
}

async function tryFixError(errorLine: string): Promise<FixAttemptResult> {
  const errorLower = errorLine.toLowerCase();

  // Fix: Missing module - try to install
  if (errorLower.includes('cannot find module') || errorLower.includes('module not found')) {
    const moduleMatch = errorLine.match(/['"]([^'"]+)['"]/);
    if (moduleMatch) {
      const moduleName = moduleMatch[1];
      
      // Skip relative imports - can't auto-fix
      if (moduleName.startsWith('.') || moduleName.startsWith('@/')) {
        return {
          fixed: false,
          description: '',
          suggestion: `Check import path: ${moduleName} - ensure file exists`,
        };
      }
      
      // Try to install the module
      try {
        console.log(chalk.dim(`  Attempting to install ${moduleName}...`));
        await execAsync(`npm install ${moduleName}`, { timeout: 60000 });
        return {
          fixed: true,
          description: `Installed missing module: ${moduleName}`,
        };
      } catch {
        return {
          fixed: false,
          description: '',
          suggestion: `Try manually: npm install ${moduleName}`,
        };
      }
    }
  }

  // Fix: shadcn component not found - try to add it
  if (errorLower.includes('@/components/ui/') && errorLower.includes('cannot find')) {
    const componentMatch = errorLine.match(/@\/components\/ui\/([a-z-]+)/i);
    if (componentMatch) {
      const component = componentMatch[1];
      try {
        console.log(chalk.dim(`  Attempting to add shadcn component: ${component}...`));
        await execAsync(`npx shadcn@latest add ${component} --yes`, { timeout: 60000 });
        return {
          fixed: true,
          description: `Added shadcn component: ${component}`,
        };
      } catch {
        return {
          fixed: false,
          description: '',
          suggestion: `Try manually: npx shadcn@latest add ${component}`,
        };
      }
    }
  }

  // Fix: Framer Motion ease type error
  if (errorLower.includes('ease') && errorLower.includes('easing') && errorLower.includes('type')) {
    return {
      fixed: false,
      description: '',
      suggestion: 'Replace ease: "easeOut" with ease: [0.4, 0, 0.2, 1] in animation variants',
    };
  }

  // Fix: Tailwind unknown utility class
  if (errorLower.includes('unknown utility class')) {
    const classMatch = errorLine.match(/class [`']([^`']+)[`']/i);
    if (classMatch) {
      const className = classMatch[1];
      return {
        fixed: false,
        description: '',
        suggestion: `Remove @apply ${className} from CSS - use inline Tailwind classes instead`,
      };
    }
  }

  // Fix: Missing "use client" directive
  if (errorLower.includes('usestate') || errorLower.includes('useeffect')) {
    if (errorLower.includes('server component')) {
      return {
        fixed: false,
        description: '',
        suggestion: 'Add "use client" at the top of the file that uses React hooks',
      };
    }
  }

  return {
    fixed: false,
    description: '',
    suggestion: undefined,
  };
}

/**
 * Run build and attempt auto-fixes
 */
export async function buildWithAutoFix(maxAttempts: number = 2): Promise<{
  success: boolean;
  output: string;
  fixesApplied: string[];
}> {
  let attempts = 0;
  let lastOutput = '';
  const allFixes: string[] = [];

  while (attempts < maxAttempts) {
    attempts++;
    
    try {
      const { stdout, stderr } = await execAsync('npm run build', {
        cwd: process.cwd(),
        timeout: 120000,
        env: { ...process.env, CI: 'true' },
      });
      
      // Build succeeded
      return {
        success: true,
        output: stdout + stderr,
        fixesApplied: allFixes,
      };
    } catch (error: any) {
      lastOutput = error.stderr || error.stdout || error.message || '';
      
      if (attempts < maxAttempts) {
        console.log(chalk.yellow(`\n⚠️  Build failed. Attempting auto-fix (attempt ${attempts}/${maxAttempts})...\n`));
        
        const fixResult = await attemptAutoFix(lastOutput);
        
        if (fixResult.fixed) {
          console.log(chalk.green('  Auto-fixes applied:'));
          fixResult.fixesApplied.forEach(f => {
            console.log(chalk.green(`    ✓ ${f}`));
            allFixes.push(f);
          });
          console.log(chalk.dim('\n  Retrying build...\n'));
        } else {
          // No fixes could be applied, show suggestions and stop
          if (fixResult.suggestions.length > 0) {
            console.log(chalk.yellow('\n  Could not auto-fix. Suggestions:'));
            fixResult.suggestions.forEach(s => console.log(chalk.yellow(`    → ${s}`)));
          }
          break;
        }
      }
    }
  }

  return {
    success: false,
    output: lastOutput,
    fixesApplied: allFixes,
  };
}

/**
 * Display auto-fix results
 */
export function displayAutoFixResults(result: AutoFixResult): void {
  if (result.fixesApplied.length > 0) {
    console.log(chalk.green('\n✅ Auto-fixes applied:'));
    result.fixesApplied.forEach(f => console.log(chalk.green(`  • ${f}`)));
  }

  if (result.suggestions.length > 0) {
    console.log(chalk.yellow('\n💡 Suggested manual fixes:'));
    result.suggestions.forEach(s => console.log(chalk.yellow(`  • ${s}`)));
  }

  if (result.remainingErrors.length > 0) {
    console.log(chalk.red('\n❌ Remaining errors:'));
    result.remainingErrors.slice(0, 5).forEach(e => console.log(chalk.dim(`  ${e.substring(0, 100)}`)));
    if (result.remainingErrors.length > 5) {
      console.log(chalk.dim(`  ... and ${result.remainingErrors.length - 5} more`));
    }
  }
}
