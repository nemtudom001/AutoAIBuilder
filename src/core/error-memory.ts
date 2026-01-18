import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { getProjectPhasesDir } from './config-manager.js';

export interface ErrorPattern {
  id: string;
  errorSignature: string; // Normalized error pattern
  errorType: 'typescript' | 'module' | 'build' | 'runtime' | 'syntax' | 'unknown';
  originalError: string;
  fix: string;
  fixType: 'npm_install' | 'shadcn_add' | 'code_change' | 'config_change' | 'manual';
  successCount: number;
  lastUsed: string;
  context?: string; // Additional context about when this fix works
}

export interface ErrorMemoryState {
  patterns: ErrorPattern[];
  totalFixes: number;
  lastUpdated: string;
}

const ERROR_MEMORY_FILE = 'error-memory.json';

/**
 * Normalize error message to create a signature for matching
 */
function normalizeErrorSignature(error: string): string {
  return error
    // Remove file paths (they vary)
    .replace(/[A-Za-z]:\\[^\s:]+/g, '<PATH>')
    .replace(/\/[^\s:]+/g, '<PATH>')
    // Remove line numbers
    .replace(/:\d+:\d+/g, ':<LINE>')
    .replace(/line \d+/gi, 'line <LINE>')
    // Remove specific variable/function names in quotes
    .replace(/'[^']+'/g, "'<NAME>'")
    .replace(/"[^"]+"/g, '"<NAME>"')
    // Remove version numbers
    .replace(/\d+\.\d+\.\d+/g, '<VERSION>')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .substring(0, 200); // Limit length
}

/**
 * Detect error type from error message
 */
function detectErrorType(error: string): ErrorPattern['errorType'] {
  const errorLower = error.toLowerCase();
  
  if (errorLower.includes('cannot find module') || errorLower.includes('module not found')) {
    return 'module';
  }
  if (errorLower.includes('type error') || errorLower.includes('is not assignable') || errorLower.includes('error ts')) {
    return 'typescript';
  }
  if (errorLower.includes('syntax error') || errorLower.includes('unexpected token')) {
    return 'syntax';
  }
  if (errorLower.includes('build failed') || errorLower.includes('failed to compile')) {
    return 'build';
  }
  if (errorLower.includes('runtime') || errorLower.includes('reference error') || errorLower.includes('type error:')) {
    return 'runtime';
  }
  
  return 'unknown';
}

/**
 * Load error memory from project
 */
export async function loadErrorMemory(): Promise<ErrorMemoryState> {
  const memoryPath = path.join(getProjectPhasesDir(), ERROR_MEMORY_FILE);
  
  if (await fs.pathExists(memoryPath)) {
    return await fs.readJson(memoryPath);
  }
  
  return {
    patterns: [],
    totalFixes: 0,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Save error memory
 */
async function saveErrorMemory(state: ErrorMemoryState): Promise<void> {
  const memoryPath = path.join(getProjectPhasesDir(), ERROR_MEMORY_FILE);
  state.lastUpdated = new Date().toISOString();
  await fs.ensureDir(path.dirname(memoryPath));
  await fs.writeJson(memoryPath, state, { spaces: 2 });
}

/**
 * Find a matching fix for an error
 */
export async function findMatchingFix(error: string): Promise<ErrorPattern | null> {
  const state = await loadErrorMemory();
  const signature = normalizeErrorSignature(error);
  
  // Look for exact signature match first
  const exactMatch = state.patterns.find(p => p.errorSignature === signature);
  if (exactMatch) {
    console.log(chalk.cyan(`  💡 Found exact match in error memory (used ${exactMatch.successCount} times)`));
    return exactMatch;
  }
  
  // Look for partial matches (substring matching)
  const errorType = detectErrorType(error);
  const partialMatches = state.patterns.filter(p => {
    // Same error type
    if (p.errorType !== errorType) return false;
    
    // Check for significant substring overlap
    const overlap = getOverlapScore(signature, p.errorSignature);
    return overlap > 0.6; // 60% similarity threshold
  });
  
  if (partialMatches.length > 0) {
    // Return the most successful match
    const bestMatch = partialMatches.sort((a, b) => b.successCount - a.successCount)[0];
    console.log(chalk.cyan(`  💡 Found similar error in memory (${bestMatch.successCount} successful fixes)`));
    return bestMatch;
  }
  
  return null;
}

/**
 * Calculate overlap score between two signatures
 */
function getOverlapScore(sig1: string, sig2: string): number {
  const words1 = new Set(sig1.split(' '));
  const words2 = new Set(sig2.split(' '));
  
  let overlap = 0;
  words1.forEach(w => {
    if (words2.has(w)) overlap++;
  });
  
  const maxWords = Math.max(words1.size, words2.size);
  return maxWords > 0 ? overlap / maxWords : 0;
}

/**
 * Record a successful fix for future reference
 */
export async function recordSuccessfulFix(
  error: string,
  fix: string,
  fixType: ErrorPattern['fixType'],
  context?: string
): Promise<void> {
  const state = await loadErrorMemory();
  const signature = normalizeErrorSignature(error);
  const errorType = detectErrorType(error);
  
  // Check if pattern already exists
  const existingIndex = state.patterns.findIndex(p => p.errorSignature === signature);
  
  if (existingIndex >= 0) {
    // Update existing pattern
    state.patterns[existingIndex].successCount++;
    state.patterns[existingIndex].lastUsed = new Date().toISOString();
    if (context) {
      state.patterns[existingIndex].context = context;
    }
  } else {
    // Add new pattern
    const pattern: ErrorPattern = {
      id: `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      errorSignature: signature,
      errorType,
      originalError: error.substring(0, 500), // Keep first 500 chars
      fix,
      fixType,
      successCount: 1,
      lastUsed: new Date().toISOString(),
      context,
    };
    state.patterns.push(pattern);
  }
  
  state.totalFixes++;
  await saveErrorMemory(state);
  
  console.log(chalk.dim(`  📝 Recorded fix in error memory`));
}

/**
 * Get fix suggestion based on error type
 */
export function getSuggestedFix(pattern: ErrorPattern): string {
  switch (pattern.fixType) {
    case 'npm_install':
      return `npm install ${pattern.fix}`;
    case 'shadcn_add':
      return `npx shadcn@latest add ${pattern.fix} --yes`;
    case 'code_change':
      return pattern.fix;
    case 'config_change':
      return pattern.fix;
    default:
      return pattern.fix;
  }
}

/**
 * Apply a known fix automatically
 */
export async function applyKnownFix(pattern: ErrorPattern): Promise<boolean> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    switch (pattern.fixType) {
      case 'npm_install':
        console.log(chalk.cyan(`  🔧 Auto-applying fix: npm install ${pattern.fix}`));
        await execAsync(`npm install ${pattern.fix}`, { timeout: 60000 });
        return true;
        
      case 'shadcn_add':
        console.log(chalk.cyan(`  🔧 Auto-applying fix: adding shadcn component ${pattern.fix}`));
        await execAsync(`npx shadcn@latest add ${pattern.fix} --yes`, { timeout: 60000 });
        return true;
        
      case 'code_change':
      case 'config_change':
        // These require AI intervention, can't auto-apply
        console.log(chalk.dim(`  ℹ Fix requires code change: ${pattern.fix.substring(0, 100)}`));
        return false;
        
      default:
        return false;
    }
  } catch (error) {
    console.log(chalk.yellow(`  ⚠ Auto-fix failed`));
    return false;
  }
}

/**
 * Display error memory stats
 */
export async function displayErrorMemoryStats(): Promise<void> {
  const state = await loadErrorMemory();
  
  console.log(chalk.cyan('\n📊 Error Memory Statistics:\n'));
  console.log(chalk.dim(`  Total patterns stored: ${state.patterns.length}`));
  console.log(chalk.dim(`  Total successful fixes: ${state.totalFixes}`));
  
  if (state.patterns.length > 0) {
    // Group by error type
    const byType: Record<string, number> = {};
    state.patterns.forEach(p => {
      byType[p.errorType] = (byType[p.errorType] || 0) + 1;
    });
    
    console.log(chalk.dim('\n  By error type:'));
    Object.entries(byType).forEach(([type, count]) => {
      console.log(chalk.dim(`    ${type}: ${count} patterns`));
    });
    
    // Show top fixes
    const topFixes = state.patterns
      .sort((a, b) => b.successCount - a.successCount)
      .slice(0, 5);
    
    if (topFixes.length > 0) {
      console.log(chalk.dim('\n  Top 5 most used fixes:'));
      topFixes.forEach((p, i) => {
        console.log(chalk.dim(`    ${i + 1}. ${p.fixType}: ${p.fix.substring(0, 50)}... (${p.successCount} uses)`));
      });
    }
  }
  
  console.log();
}

/**
 * Clear error memory (for reset)
 */
export async function clearErrorMemory(): Promise<void> {
  const memoryPath = path.join(getProjectPhasesDir(), ERROR_MEMORY_FILE);
  if (await fs.pathExists(memoryPath)) {
    await fs.remove(memoryPath);
  }
}
