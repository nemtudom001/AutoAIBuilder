import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { loadGlobalConfig, getProjectPhasesDir } from './config-manager.js';

const execAsync = promisify(exec);

// On Windows, run cursor-agent through WSL Ubuntu
const isWindows = process.platform === 'win32';

/**
 * Convert Windows path to WSL path (C:\Users\... -> /mnt/c/Users/...)
 */
function toWslPath(windowsPath: string): string {
  if (!isWindows) return windowsPath;
  // C:\Users\... -> /mnt/c/Users/...
  return windowsPath
    .replace(/^([A-Z]):/i, (_, letter) => `/mnt/${letter.toLowerCase()}`)
    .replace(/\\/g, '/');
}

/**
 * Get the command to run cursor-agent (handles Windows WSL)
 */
function getCursorAgentCommand(args: string): string {
  if (isWindows) {
    return `wsl -d Ubuntu -e bash -c "/root/.local/bin/cursor-agent ${args}"`;
  }
  return `cursor-agent ${args}`;
}

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
  manualMode?: boolean;
  promptPath?: string;
}

/**
 * Check if we're in manual mode (no agent CLI available)
 * Only returns true if the CLI is not installed
 */
export async function isManualMode(): Promise<boolean> {
  return !(await isCursorCliInstalled());
}

/**
 * Check if Cursor CLI (agent) is installed
 * CLI docs: https://cursor.com/docs/cli/installation
 */
export async function isCursorCliInstalled(): Promise<boolean> {
  try {
    await execAsync(getCursorAgentCommand('--version'), { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with Cursor CLI
 * Uses `agent` command to verify login state
 */
export async function isCursorCliAuthenticated(): Promise<boolean> {
  try {
    // The agent command will indicate auth status
    const { stdout } = await execAsync(getCursorAgentCommand('--version'), { timeout: 10000 });
    // If version returns, CLI is installed - auth is handled per-request
    return true;
  } catch {
    return false;
  }
}

/**
 * Get installation instructions based on OS
 */
export function getInstallInstructions(): string {
  const isWindows = process.platform === 'win32';
  
  if (isWindows) {
    return `Install Cursor CLI:
  
  Option 1 - WSL (recommended):
    1. Install WSL: wsl --install
    2. Restart your computer
    3. Open WSL terminal and run: curl https://cursor.com/install -fsS | bash
    4. Add to PATH: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
  
  Option 2 - Git Bash:
    1. Open Git Bash
    2. Run: curl https://cursor.com/install -fsS | bash
    3. Add to PATH in Git Bash: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  
  See: https://cursor.com/docs/cli/installation`;
  }
  
  return `Install Cursor CLI:
    curl https://cursor.com/install -fsS | bash
    
  Then add to PATH:
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
    source ~/.bashrc
    
  See: https://cursor.com/docs/cli/installation`;
}

/**
 * Run in manual mode - save prompt to file and return instructions
 * User will copy the prompt to Cursor IDE manually
 */
export async function runManualMode(options: CursorCliOptions, phaseNumber?: number, attemptNumber?: number): Promise<CursorCliResult> {
  const workingDir = options.workingDir || process.cwd();
  
  // Determine prompt file path
  let promptPath: string;
  if (phaseNumber !== undefined && attemptNumber !== undefined) {
    promptPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      `attempt-${attemptNumber}`,
      'prompt.md'
    );
  } else {
    promptPath = path.join(getProjectPhasesDir(), 'current-prompt.md');
  }
  
  await fs.ensureDir(path.dirname(promptPath));
  await fs.writeFile(promptPath, options.prompt);
  
  return {
    success: true,
    output: '',
    manualMode: true,
    promptPath,
  };
}

/**
 * Run cursor-agent in headless mode with a prompt
 * This is the core function that executes AI tasks automatically
 * Uses session-based authentication (cursor-agent login)
 * 
 * NOTE: Falls back to manual mode since cursor-agent CLI doesn't exist publicly
 */
export async function runCursorAgent(options: CursorCliOptions, phaseNumber?: number, attemptNumber?: number): Promise<CursorCliResult> {
  // Check if we should use manual mode
  const manualMode = await isManualMode();
  if (manualMode) {
    return runManualMode(options, phaseNumber, attemptNumber);
  }
  
  const cliInstalled = await isCursorCliInstalled();
  if (!cliInstalled) {
    // Fall back to manual mode
    return runManualMode(options, phaseNumber, attemptNumber);
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
  
  // Save prompt to a temp file for long prompts
  const promptFile = path.join(getProjectPhasesDir(), '.temp-prompt.md');
  await fs.ensureDir(path.dirname(promptFile));
  await fs.writeFile(promptFile, options.prompt);
  
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    
    // Pass prompt directly as argument to cursor-agent
    // Using spawn with args array avoids shell escaping issues
    const wslWorkingDir = toWslPath(workingDir);
    const agentArgs = [
      '-p',
      '-f', 
      '--model', model,
      '--output-format', 'text',
      '--workspace', isWindows ? wslWorkingDir : workingDir, // Convert path for WSL
      '--approve-mcps', // Enable MCP servers (including Context7) for documentation lookup
      '--',
      options.prompt,
    ];
    
    // On Windows, spawn through WSL
    let child;
    if (isWindows) {
      // Escape single quotes and construct WSL command
      const escapedPrompt = options.prompt.replace(/'/g, "'\\''");
      const wslCommand = `/root/.local/bin/cursor-agent -p -f --model "${model}" --output-format text --workspace "${wslWorkingDir}" --approve-mcps -- '${escapedPrompt}'`;
      child = spawn('wsl', ['-d', 'Ubuntu', '-e', 'bash', '-c', wslCommand], {
        cwd: workingDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      child = spawn('cursor-agent', agentArgs, {
        cwd: workingDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin to prevent blocking
      });
    }
    
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
  const model = config?.cursor?.planning_model || 'opus-4.5';
  
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
 * 
 * IMPORTANT: Be careful not to strip content that contains internal code fences
 * (like ```bash blocks for validation commands)
 */
export function extractMarkdown(output: string): string {
  const trimmed = output.trim();
  
  // Check if the ENTIRE output is wrapped in a single markdown code fence
  // The output should start with ```markdown or ```md and end with ```
  const startsWithFence = /^```(?:markdown|md)\s*\n/.test(trimmed);
  const endsWithFence = /\n```\s*$/.test(trimmed);
  
  if (startsWithFence && endsWithFence) {
    // Find the position after the opening fence
    const firstNewline = trimmed.indexOf('\n');
    // Find the position of the LAST closing fence (not the first)
    const lastFenceIndex = trimmed.lastIndexOf('\n```');
    
    // Only strip if the last fence is truly the closing fence of the outer wrapper
    // Check that there's content between the fences and it looks like markdown
    if (firstNewline !== -1 && lastFenceIndex > firstNewline) {
      const innerContent = trimmed.substring(firstNewline + 1, lastFenceIndex).trim();
      
      // Verify this looks like actual markdown content (has headers or structure)
      // and not just code that happens to start with #
      if (innerContent.startsWith('#') || innerContent.includes('\n## ')) {
        return innerContent;
      }
    }
  }
  
  // Check for AI preamble and strip it
  // Common patterns: "Here is the plan:", "Let me create...", "Now I have..."
  let cleaned = trimmed;
  
  // Check if this is a meta-response rather than actual content
  // Meta-responses describe what was done instead of being the content
  const metaResponsePatterns = [
    /^I(?:'ve| have) (?:created|generated|written|made)/i,
    /^The document (?:includes|contains)/i,
    /^This (?:handover|document) (?:includes|contains)/i,
  ];
  
  const isMetaResponse = metaResponsePatterns.some(p => p.test(cleaned));
  
  // If it's a meta-response, try to find actual markdown content (starting with #)
  if (isMetaResponse) {
    const markdownStart = cleaned.search(/^#\s+/m);
    if (markdownStart > 0) {
      cleaned = cleaned.substring(markdownStart);
    }
  }
  
  // Remove common AI preamble that appears before the actual content
  const preamblePatterns = [
    /^(?:Here(?:'s| is) (?:the|your|a)[^\n]*\n+)/i,
    /^(?:Now I (?:have|will|can)[^\n]*\n+)/i,
    /^(?:Let me [^\n]*\n+)/i,
    /^(?:I(?:'ll| will) [^\n]*\n+)/i,
    /^#+\s*Response:?\s*\n+/im,
  ];
  
  for (const pattern of preamblePatterns) {
    // Only remove if there's actual markdown content after the preamble
    const match = cleaned.match(pattern);
    if (match) {
      const afterPreamble = cleaned.substring(match[0].length);
      // Check if what follows looks like markdown (starts with # or has structure)
      if (afterPreamble.startsWith('#') || afterPreamble.includes('\n## ')) {
        cleaned = afterPreamble;
        break;
      }
    }
  }
  
  return cleaned.trim();
}
