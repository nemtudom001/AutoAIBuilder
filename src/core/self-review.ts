import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { getProjectPhasesDir } from './config-manager.js';
import { loadGlobalConfig } from './config-manager.js';
import { runCursorAgent } from './cursor-cli.js';
import type { PhaseState } from './state-manager.js';

export interface SelfReviewResult {
  passed: boolean;
  issues: SelfReviewIssue[];
  suggestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface SelfReviewIssue {
  severity: 'critical' | 'warning' | 'info';
  file?: string;
  description: string;
  suggestedFix?: string;
}

/**
 * Perform AI self-review before validation
 * This catches obvious mistakes before running validation commands
 */
export async function performSelfReview(
  phase: PhaseState,
  filesModified: string[],
  phaseOutput: string
): Promise<SelfReviewResult> {
  const config = await loadGlobalConfig();
  if (!config) {
    return { passed: true, issues: [], suggestions: [], confidence: 'low' };
  }

  // Read the content of modified files for review
  const fileContents: string[] = [];
  for (const file of filesModified.slice(0, 10)) { // Limit to 10 files
    try {
      if (await fs.pathExists(file)) {
        const content = await fs.readFile(file, 'utf-8');
        // Only include first 100 lines to stay within context limits
        const lines = content.split('\n').slice(0, 100).join('\n');
        fileContents.push(`### ${file}\n\`\`\`\n${lines}\n${content.split('\n').length > 100 ? '...(truncated)' : ''}\`\`\``);
      }
    } catch {
      // Skip unreadable files
    }
  }

  const reviewPrompt = `# Self-Review: Phase ${phase.phase_number} - ${phase.name}

You are reviewing code that was just written. Your job is to catch obvious mistakes BEFORE validation runs.

## Phase Tasks That Should Be Completed
${phase.tasks.map((t, i) => `${i + 1}. ${t.description}`).join('\n')}

## Validation Criteria That Must Pass
${phase.validation_criteria.map(c => `- ${c}`).join('\n')}

## Files Modified
${filesModified.map(f => `- ${f}`).join('\n')}

## File Contents (for review)
${fileContents.join('\n\n')}

## Phase Output Summary
${phaseOutput.substring(0, 2000)}${phaseOutput.length > 2000 ? '\n...(truncated)' : ''}

---

## Your Review Task

Check for these common issues:
1. **Missing imports** - Are all used components/functions imported?
2. **Typos in file paths** - Do import paths match actual file locations?
3. **Incomplete implementations** - Are there TODO comments or placeholder code?
4. **Type errors** - Are there obvious TypeScript issues?
5. **Missing exports** - Are components/functions properly exported?
6. **Syntax errors** - Missing brackets, semicolons, etc.?
7. **Missing "use client"** - React hooks in server components?
8. **Task completion** - Does the code actually implement all tasks?

## Output Format (JSON)

Respond with ONLY valid JSON in this exact format:
\`\`\`json
{
  "passed": true/false,
  "confidence": "high"/"medium"/"low",
  "issues": [
    {
      "severity": "critical"/"warning"/"info",
      "file": "path/to/file.tsx",
      "description": "What's wrong",
      "suggestedFix": "How to fix it"
    }
  ],
  "suggestions": [
    "General improvement suggestion"
  ]
}
\`\`\`

Rules:
- "passed" should be false if there are ANY critical issues
- Only report real issues, not style preferences
- Be specific about file and line if possible
- Keep suggestions actionable
`;

  try {
    const result = await runCursorAgent({
      prompt: reviewPrompt,
      model: config.cursor.execution_model,
      workingDir: process.cwd(),
      timeout: 120000, // 2 minutes for review
    });

    if (result.success && result.output) {
      // Parse JSON from output
      const jsonMatch = result.output.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          return {
            passed: parsed.passed ?? true,
            issues: parsed.issues || [],
            suggestions: parsed.suggestions || [],
            confidence: parsed.confidence || 'medium',
          };
        } catch {
          // JSON parse failed, assume passed
        }
      }
    }
  } catch {
    // Review failed, don't block - just assume passed
  }

  return { passed: true, issues: [], suggestions: [], confidence: 'low' };
}

/**
 * Display self-review results
 */
export function displaySelfReviewResults(result: SelfReviewResult): void {
  if (result.passed && result.issues.length === 0) {
    console.log(chalk.green('✓ Self-review passed'));
    return;
  }

  console.log(chalk.yellow('\n━━━ Self-Review Results ━━━\n'));
  console.log(chalk.dim(`Confidence: ${result.confidence}`));

  // Group issues by severity
  const critical = result.issues.filter(i => i.severity === 'critical');
  const warnings = result.issues.filter(i => i.severity === 'warning');
  const info = result.issues.filter(i => i.severity === 'info');

  if (critical.length > 0) {
    console.log(chalk.red('\n❌ Critical Issues:'));
    critical.forEach(issue => {
      console.log(chalk.red(`  • ${issue.description}`));
      if (issue.file) console.log(chalk.dim(`    File: ${issue.file}`));
      if (issue.suggestedFix) console.log(chalk.cyan(`    Fix: ${issue.suggestedFix}`));
    });
  }

  if (warnings.length > 0) {
    console.log(chalk.yellow('\n⚠️  Warnings:'));
    warnings.forEach(issue => {
      console.log(chalk.yellow(`  • ${issue.description}`));
      if (issue.file) console.log(chalk.dim(`    File: ${issue.file}`));
      if (issue.suggestedFix) console.log(chalk.cyan(`    Fix: ${issue.suggestedFix}`));
    });
  }

  if (info.length > 0) {
    console.log(chalk.blue('\nℹ️  Info:'));
    info.forEach(issue => {
      console.log(chalk.blue(`  • ${issue.description}`));
    });
  }

  if (result.suggestions.length > 0) {
    console.log(chalk.dim('\n💡 Suggestions:'));
    result.suggestions.forEach(s => console.log(chalk.dim(`  • ${s}`)));
  }

  console.log();
}

/**
 * Save self-review results to file
 */
export async function saveSelfReviewResults(
  phaseNumber: number,
  attemptNumber: number,
  result: SelfReviewResult
): Promise<void> {
  const reviewPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'self-review.json'
  );

  await fs.ensureDir(path.dirname(reviewPath));
  await fs.writeJson(reviewPath, result, { spaces: 2 });
}
