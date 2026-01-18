import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadGlobalConfig, getProjectPhasesDir } from '../../core/config-manager.js';
import {
  loadProjectState,
  loadPhaseState,
  loadAttemptState,
} from '../../core/state-manager.js';
import {
  generateHandoverPrompt,
  buildCursorPrompt,
} from '../../core/prompt-builder.js';
import {
  runPlanningTask,
  isCursorCliInstalled,
  getCursorApiKey,
  extractMarkdown,
} from '../../core/cursor-cli.js';

interface HandoverOptions {
  phase?: string;
  summarize?: boolean;
}

export async function handoverCommand(options: HandoverOptions): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig || !globalConfig.setup_complete) {
    console.log(chalk.yellow('Please run setup first: ai-phases config --setup'));
    process.exit(1);
  }
  
  // Verify CLI setup
  const cliInstalled = await isCursorCliInstalled();
  if (!cliInstalled) {
    console.log(chalk.red('\n✗ cursor-agent CLI not found.'));
    console.log(chalk.dim('Install with: curl https://cursor.com/install -fsS | bash\n'));
    process.exit(1);
  }
  
  const apiKey = await getCursorApiKey();
  if (!apiKey) {
    console.log(chalk.red('\n✗ Cursor API key not configured.'));
    console.log(chalk.dim('Run: ai-phases config --setup\n'));
    process.exit(1);
  }
  
  const state = await loadProjectState();
  if (!state) {
    console.log(chalk.yellow('Project not initialized. Run: ai-phases init'));
    process.exit(1);
  }
  
  // Determine phase number
  let phaseNumber: number;
  if (options.phase) {
    phaseNumber = parseInt(options.phase, 10);
  } else {
    // Find the most recently completed phase
    const completedPhases = state.phases
      .filter(p => p.status === 'completed')
      .sort((a, b) => b.phase_number - a.phase_number);
    
    if (completedPhases.length === 0) {
      console.log(chalk.yellow('No completed phases found. Complete a phase first.'));
      return;
    }
    
    phaseNumber = completedPhases[0].phase_number;
  }
  
  const phase = await loadPhaseState(phaseNumber);
  if (!phase) {
    console.log(chalk.red(`Phase ${phaseNumber} not found.`));
    return;
  }
  
  console.log(chalk.cyan(`\n📋 Generating handover for Phase ${phaseNumber}: ${phase.name}\n`));
  
  // Check if handover already exists
  const handoverPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    'handover.md'
  );
  
  if (await fs.pathExists(handoverPath)) {
    console.log(chalk.yellow('⚠️  Handover already exists. Regenerating...'));
    console.log(chalk.dim(`  Previous: ${handoverPath}\n`));
  }
  
  // Load the latest attempt output if available
  let phaseOutput = '';
  const latestAttempt = phase.current_attempt;
  if (latestAttempt > 0) {
    const outputPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      `attempt-${latestAttempt}`,
      'output.md'
    );
    if (await fs.pathExists(outputPath)) {
      phaseOutput = await fs.readFile(outputPath, 'utf-8');
    }
  }
  
  // Get modified files from git status or attempt state
  let filesModified: string[] = [];
  const attemptState = await loadAttemptState(phaseNumber, latestAttempt);
  if (attemptState?.files_modified) {
    filesModified = attemptState.files_modified;
  }
  
  // Generate handover prompt
  const prompt = await generateHandoverPrompt(phase);
  const fullPrompt = buildCursorPrompt(prompt);
  
  // Add phase output context if available
  const enhancedPrompt = phaseOutput 
    ? `${fullPrompt}\n\n## Phase Output Reference\n${phaseOutput.substring(0, 3000)}${phaseOutput.length > 3000 ? '\n...(truncated)' : ''}`
    : fullPrompt;
  
  // Save prompt for reference
  const promptPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    'handover-prompt.md'
  );
  await fs.writeFile(promptPath, enhancedPrompt);
  console.log(chalk.dim('Prompt saved: ') + chalk.white(promptPath));
  
  // Run handover generation automatically
  const spinner = ora({
    text: `Generating handover summary using ${prompt.modelName}...`,
    spinner: 'dots12',
  }).start();
  
  const startTime = Date.now();
  const result = await runPlanningTask(enhancedPrompt);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  
  if (!result.success) {
    spinner.fail(`Handover generation failed after ${elapsed}s`);
    console.log(chalk.red('\nError: ') + chalk.dim(result.error || 'Unknown error'));
    console.log(chalk.yellow('\nRetry with: ai-phases handover --phase ' + phaseNumber));
    return;
  }
  
  spinner.succeed(`Handover generated in ${elapsed}s`);
  
  // Extract and process handover content
  let handoverContent = extractMarkdown(result.output);
  
  // Apply summarization if requested
  if (options.summarize) {
    handoverContent = summarizeHandover(handoverContent);
    console.log(chalk.dim('Summarized handover for context efficiency.'));
  }
  
  // Save handover
  await fs.writeFile(handoverPath, handoverContent);
  
  console.log(chalk.green(`\n✓ Handover saved: ${handoverPath}`));
  
  // Show preview
  console.log(chalk.dim('\n── Handover Preview ──────────────────────────────────────────'));
  const preview = handoverContent.split('\n').slice(0, 15).join('\n');
  console.log(chalk.white(preview));
  if (handoverContent.split('\n').length > 15) {
    console.log(chalk.dim('  ... (see full handover for details)'));
  }
  console.log(chalk.dim('──────────────────────────────────────────────────────────────\n'));
  
  // Show next steps
  if (phaseNumber < state.total_phases) {
    console.log(chalk.white('Next step:'));
    console.log(chalk.cyan(`  ai-phases run --phase ${phaseNumber + 1}\n`));
  } else {
    console.log(chalk.green('\n🎉 This was the final phase! Project complete.\n'));
  }
}

function summarizeHandover(content: string): string {
  // Simple summarization - keep headings and first item under each
  const lines = content.split('\n');
  const summarized: string[] = [];
  let inList = false;
  let listItemCount = 0;
  const maxListItems = 3;
  
  for (const line of lines) {
    if (line.startsWith('#')) {
      summarized.push(line);
      inList = false;
      listItemCount = 0;
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.match(/^\d+\./)) {
      if (!inList || listItemCount < maxListItems) {
        summarized.push(line);
        inList = true;
        listItemCount++;
      } else if (listItemCount === maxListItems) {
        summarized.push('- ... (see full handover for details)');
        listItemCount++;
      }
    } else if (line.trim() === '') {
      summarized.push(line);
      inList = false;
      listItemCount = 0;
    } else if (!inList) {
      summarized.push(line);
    }
  }
  
  return summarized.join('\n');
}
