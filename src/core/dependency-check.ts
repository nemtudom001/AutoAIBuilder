import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { PhaseState } from './state-manager.js';

const execAsync = promisify(exec);

export interface DependencyCheckResult {
  missingDependencies: string[];
  missingShadcnComponents: string[];
  suggestedInstalls: string[];
  preInstalled: string[];
}

// Common library patterns to detect from task descriptions
const LIBRARY_PATTERNS: Array<{ pattern: RegExp; packages: string[] }> = [
  { pattern: /framer\s*motion|animation|animate/i, packages: ['motion'] },
  { pattern: /form|validation|zod/i, packages: ['react-hook-form', 'zod', '@hookform/resolvers'] },
  { pattern: /date|calendar|picker/i, packages: ['date-fns'] },
  { pattern: /chart|graph|visualization/i, packages: ['recharts'] },
  { pattern: /drag\s*and\s*drop|dnd|sortable/i, packages: ['@dnd-kit/core', '@dnd-kit/sortable'] },
  { pattern: /toast|notification/i, packages: ['sonner'] },
  { pattern: /icon/i, packages: ['lucide-react'] },
  { pattern: /carousel|slider|swiper/i, packages: ['embla-carousel-react'] },
  { pattern: /markdown|mdx/i, packages: ['react-markdown'] },
  { pattern: /syntax\s*highlight|code\s*block/i, packages: ['prism-react-renderer'] },
  { pattern: /table|data\s*grid/i, packages: ['@tanstack/react-table'] },
  { pattern: /state\s*management|zustand/i, packages: ['zustand'] },
  { pattern: /query|fetch|api/i, packages: ['@tanstack/react-query'] },
];

// Common shadcn components to detect
const SHADCN_PATTERNS: Array<{ pattern: RegExp; components: string[] }> = [
  { pattern: /button/i, components: ['button'] },
  { pattern: /card/i, components: ['card'] },
  { pattern: /input|text\s*field/i, components: ['input', 'label'] },
  { pattern: /form/i, components: ['form', 'input', 'label', 'button'] },
  { pattern: /dialog|modal|popup/i, components: ['dialog'] },
  { pattern: /sheet|drawer|sidebar/i, components: ['sheet'] },
  { pattern: /dropdown|menu|select/i, components: ['dropdown-menu', 'select'] },
  { pattern: /tab/i, components: ['tabs'] },
  { pattern: /accordion/i, components: ['accordion'] },
  { pattern: /toast|notification/i, components: ['toast', 'sonner'] },
  { pattern: /table/i, components: ['table'] },
  { pattern: /avatar/i, components: ['avatar'] },
  { pattern: /badge/i, components: ['badge'] },
  { pattern: /checkbox/i, components: ['checkbox'] },
  { pattern: /switch|toggle/i, components: ['switch'] },
  { pattern: /slider/i, components: ['slider'] },
  { pattern: /progress/i, components: ['progress'] },
  { pattern: /tooltip/i, components: ['tooltip'] },
  { pattern: /popover/i, components: ['popover'] },
  { pattern: /calendar/i, components: ['calendar'] },
  { pattern: /command|search/i, components: ['command'] },
  { pattern: /navigation|nav|menu/i, components: ['navigation-menu'] },
  { pattern: /separator|divider/i, components: ['separator'] },
  { pattern: /skeleton|loading/i, components: ['skeleton'] },
  { pattern: /alert/i, components: ['alert'] },
  { pattern: /scroll/i, components: ['scroll-area'] },
];

/**
 * Analyze phase tasks and detect required dependencies
 */
export async function analyzeDependencies(phase: PhaseState): Promise<DependencyCheckResult> {
  const taskText = phase.tasks.map(t => t.description).join(' ') + ' ' + phase.description;
  
  const detectedPackages = new Set<string>();
  const detectedShadcn = new Set<string>();

  // Check for library patterns
  for (const { pattern, packages } of LIBRARY_PATTERNS) {
    if (pattern.test(taskText)) {
      packages.forEach(p => detectedPackages.add(p));
    }
  }

  // Check for shadcn component patterns
  for (const { pattern, components } of SHADCN_PATTERNS) {
    if (pattern.test(taskText)) {
      components.forEach(c => detectedShadcn.add(c));
    }
  }

  // Check what's already installed
  const installedPackages = await getInstalledPackages();
  const installedShadcn = await getInstalledShadcnComponents();

  const missingDependencies = [...detectedPackages].filter(p => !installedPackages.includes(p));
  const missingShadcnComponents = [...detectedShadcn].filter(c => !installedShadcn.includes(c));

  return {
    missingDependencies,
    missingShadcnComponents,
    suggestedInstalls: [...missingDependencies],
    preInstalled: [],
  };
}

/**
 * Get list of installed npm packages
 */
async function getInstalledPackages(): Promise<string[]> {
  try {
    const packageJsonPath = await findPackageJson();
    if (!packageJsonPath) return [];

    const packageJson = await fs.readJson(packageJsonPath);
    const deps = Object.keys(packageJson.dependencies || {});
    const devDeps = Object.keys(packageJson.devDependencies || {});
    return [...deps, ...devDeps];
  } catch {
    return [];
  }
}

/**
 * Get list of installed shadcn components
 */
async function getInstalledShadcnComponents(): Promise<string[]> {
  const components: string[] = [];
  
  // Check common component paths
  const componentPaths = [
    'components/ui',
    'src/components/ui',
    'app/components/ui',
  ];

  for (const componentPath of componentPaths) {
    const fullPath = path.join(process.cwd(), componentPath);
    try {
      if (await fs.pathExists(fullPath)) {
        const files = await fs.readdir(fullPath);
        for (const file of files) {
          if (file.endsWith('.tsx') || file.endsWith('.ts')) {
            components.push(file.replace(/\.(tsx?|jsx?)$/, ''));
          }
        }
      }
    } catch {
      // Path doesn't exist or can't be read
    }
  }

  return components;
}

/**
 * Find package.json in project
 */
async function findPackageJson(): Promise<string | null> {
  const possiblePaths = [
    path.join(process.cwd(), 'package.json'),
    path.join(process.cwd(), 'web', 'package.json'),
    path.join(process.cwd(), 'app', 'package.json'),
    path.join(process.cwd(), 'frontend', 'package.json'),
  ];

  for (const p of possiblePaths) {
    if (await fs.pathExists(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Pre-install detected missing dependencies
 */
export async function preInstallDependencies(
  result: DependencyCheckResult
): Promise<{ installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];

  // Find project directory
  const packageJsonPath = await findPackageJson();
  const projectDir = packageJsonPath ? path.dirname(packageJsonPath) : process.cwd();

  // Install npm packages
  if (result.missingDependencies.length > 0) {
    console.log(chalk.cyan('\n📦 Pre-installing detected dependencies...\n'));
    
    for (const pkg of result.missingDependencies) {
      try {
        console.log(chalk.dim(`  Installing ${pkg}...`));
        await execAsync(`npm install ${pkg}`, { 
          cwd: projectDir,
          timeout: 60000 
        });
        installed.push(pkg);
        console.log(chalk.green(`  ✓ Installed ${pkg}`));
      } catch (error: any) {
        failed.push(pkg);
        console.log(chalk.yellow(`  ⚠ Failed to install ${pkg}: ${error.message?.split('\n')[0]}`));
      }
    }
  }

  // Install shadcn components
  if (result.missingShadcnComponents.length > 0) {
    console.log(chalk.cyan('\n🎨 Pre-installing shadcn components...\n'));
    
    for (const component of result.missingShadcnComponents) {
      try {
        console.log(chalk.dim(`  Adding ${component}...`));
        await execAsync(`npx shadcn@latest add ${component} --yes`, { 
          cwd: projectDir,
          timeout: 60000 
        });
        installed.push(`shadcn:${component}`);
        console.log(chalk.green(`  ✓ Added ${component}`));
      } catch (error: any) {
        failed.push(`shadcn:${component}`);
        console.log(chalk.yellow(`  ⚠ Failed to add ${component}: ${error.message?.split('\n')[0]}`));
      }
    }
  }

  if (installed.length > 0) {
    console.log(chalk.green(`\n✓ Pre-installed ${installed.length} dependencies`));
  }

  return { installed, failed };
}

/**
 * Display dependency check results
 */
export function displayDependencyCheck(result: DependencyCheckResult): void {
  const total = result.missingDependencies.length + result.missingShadcnComponents.length;
  
  if (total === 0) {
    console.log(chalk.green('✓ No missing dependencies detected'));
    return;
  }

  console.log(chalk.yellow(`\n📦 Detected ${total} potentially missing dependencies:\n`));

  if (result.missingDependencies.length > 0) {
    console.log(chalk.dim('NPM Packages:'));
    result.missingDependencies.forEach(d => console.log(chalk.yellow(`  • ${d}`)));
  }

  if (result.missingShadcnComponents.length > 0) {
    console.log(chalk.dim('\nshadcn Components:'));
    result.missingShadcnComponents.forEach(c => console.log(chalk.yellow(`  • ${c}`)));
  }

  console.log();
}
