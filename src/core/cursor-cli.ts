import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { loadGlobalConfig, getProjectPhasesDir } from './config-manager.js';

const execAsync = promisify(exec);

export interface CursorCliOptions {
  prompt: string;
  model?: string;
  workingDir?: string;
  timeout?: number;
  onOutput?: (chunk: string) => void;
}

export interface CursorCliResult {
  success: boolean;
  output: string;
  error?: string;
  filesModified?: string[];
}

/**
 * Check if cursor-agent CLI is installed
 */
export async function isCursorCliInstalled(): Promise<boolean> {
  try {
    await execAsync('cursor-agent --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with Cursor CLI
 * Uses `cursor-agent status` to verify login state
 */
export async function isCursorCliAuthenticated(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('cursor-agent status', { timeout: 10000 });
    // Check for signs of authentication in status output
    return stdout.toLowerCase().includes('logged in') || 
           stdout.toLowerCase().includes('authenticated') ||
           stdout.includes('@'); // Email usually shown when logged in
  } catch {
    return false;
  }
}

/**
 * Run cursor-agent in headless mode with a prompt
 * This is the core function that executes AI tasks automatically
 * Uses session-based authentication (cursor-agent login)
 */
export async function runCursorAgent(options: CursorCliOptions): Promise<CursorCliResult> {
  const cliInstalled = await isCursorCliInstalled();
  if (!cliInstalled) {
    return {
      success: false,
      output: '',
      error: 'cursor-agent CLI not installed. Run: curl https://cursor.com/install -fsS | bash',
    };
  }
  
  const isAuthenticated = await isCursorCliAuthenticated();
  if (!isAuthenticated) {
    return {
      success: false,
      output: '',
      error: 'Not logged in to Cursor CLI. Run: cursor-agent login',
    };
  }
  
  const config = await loadGlobalConfig();
  const model = options.model || config?.cursor?.execution_model || 'gemini-3-flash';
  const timeout = options.timeout || 300000; // 5 minute default
  const workingDir = options.workingDir || process.cwd();
  
  // Save prompt to a temp file to avoid shell escaping issues
  const promptFile = path.join(getProjectPhasesDir(), '.temp-prompt.md');
  await fs.writeFile(promptFile, options.prompt);
  
  return new Promise((resolve) => {
    const args = [
      '-p', // headless/print mode
      `@${promptFile}`, // read prompt from file
      '--model', model,
      '--output-format', 'text',
      '--force', // apply changes without manual confirmation
    ];
    
    let output = '';
    let errorOutput = '';
    
    const child = spawn('cursor-agent', args, {
      cwd: workingDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        success: false,
        output,
        error: `Timeout after ${timeout / 1000} seconds`,
      });
    }, timeout);
    
    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      if (options.onOutput) {
        options.onOutput(chunk);
      }
    });
    
    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    child.on('close', async (code) => {
      clearTimeout(timeoutId);
      
      // Clean up temp file
      await fs.remove(promptFile).catch(() => {});
      
      if (code === 0) {
        // Parse output to find modified files
        const filesModified = parseModifiedFiles(output);
        
        resolve({
          success: true,
          output,
          filesModified,
        });
      } else {
        resolve({
          success: false,
          output,
          error: errorOutput || `cursor-agent exited with code ${code}`,
        });
      }
    });
    
    child.on('error', async (err) => {
      clearTimeout(timeoutId);
      await fs.remove(promptFile).catch(() => {});
      
      resolve({
        success: false,
        output,
        error: err.message,
      });
    });
  });
}

/**
 * Run cursor-agent with live output streaming and spinner
 */
export async function runCursorAgentWithProgress(
  options: CursorCliOptions,
  progressMessage: string
): Promise<CursorCliResult> {
  const spinner = ora(progressMessage).start();
  let lastOutput = '';
  
  const result = await runCursorAgent({
    ...options,
    onOutput: (chunk) => {
      // Update spinner with latest meaningful output
      const lines = chunk.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        lastOutput = lines[lines.length - 1].substring(0, 60);
        spinner.text = `${progressMessage} ${chalk.dim(lastOutput)}`;
      }
    },
  });
  
  if (result.success) {
    spinner.succeed(progressMessage + chalk.green(' Done!'));
  } else {
    spinner.fail(progressMessage + chalk.red(' Failed'));
  }
  
  return result;
}

/**
 * Run cursor-agent for a planning task (uses opus model)
 */
export async function runPlanningTask(prompt: string, workingDir?: string): Promise<CursorCliResult> {
  const config = await loadGlobalConfig();
  const model = config?.cursor?.planning_model || 'claude-opus-4.5';
  
  return runCursorAgent({
    prompt,
    model,
    workingDir,
    timeout: 600000, // 10 minutes for planning tasks
  });
}

/**
 * Run cursor-agent for a coding/execution task (uses flash model)
 */
export async function runExecutionTask(prompt: string, workingDir?: string): Promise<CursorCliResult> {
  const config = await loadGlobalConfig();
  const model = config?.cursor?.execution_model || 'gemini-3-flash';
  
  return runCursorAgent({
    prompt,
    model,
    workingDir,
    timeout: 300000, // 5 minutes for execution tasks
  });
}

/**
 * Parse cursor-agent output to find modified files
 */
function parseModifiedFiles(output: string): string[] {
  const files: string[] = [];
  
  // Look for common patterns in cursor-agent output
  // Pattern: "Modified: path/to/file" or "Created: path/to/file"
  const modifiedPattern = /(?:Modified|Created|Updated|Wrote):\s*([^\s]+)/gi;
  let match;
  while ((match = modifiedPattern.exec(output)) !== null) {
    files.push(match[1]);
  }
  
  // Pattern: file paths with common extensions
  const filePattern = /(?:^|\s)([\w\-./]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|vue|svelte))/gm;
  while ((match = filePattern.exec(output)) !== null) {
    if (!files.includes(match[1])) {
      files.push(match[1]);
    }
  }
  
  return [...new Set(files)];
}

/**
 * Extract content between markers from cursor-agent output
 * Useful for extracting specific sections like handovers or specs
 */
export function extractContent(output: string, startMarker: string, endMarker?: string): string | null {
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return null;
  
  const contentStart = startIndex + startMarker.length;
  
  if (endMarker) {
    const endIndex = output.indexOf(endMarker, contentStart);
    if (endIndex === -1) return output.substring(contentStart).trim();
    return output.substring(contentStart, endIndex).trim();
  }
  
  return output.substring(contentStart).trim();
}

/**
 * Extract markdown content from cursor output
 * Handles cases where the AI wraps output in code fences
 */
export function extractMarkdown(output: string): string {
  // If output is wrapped in markdown code fence, extract it
  const fenceMatch = output.match(/```(?:markdown|md)?\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  
  // Otherwise return the whole output, cleaned up
  return output
    .replace(/^#+\s*Response:?\s*$/gim, '')
    .replace(/^Here(?:'s| is) (?:the|your|a).*:?\s*$/gim, '')
    .trim();
}
