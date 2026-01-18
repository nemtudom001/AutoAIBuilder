import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import boxen from 'boxen';
import { loadGlobalConfig, loadProjectConfig, getProjectPhasesDir } from '../../core/config-manager.js';
import {
  loadProjectState,
  saveProjectState,
  createPhaseState,
  type PhaseState,
  type PhaseTask,
} from '../../core/state-manager.js';
import {
  generateSuperpromptEnhancement,
  generatePhaseStructuring,
  buildCursorPrompt,
  savePromptToFile,
} from '../../core/prompt-builder.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface RefineOptions {
  skipResearch?: boolean;
}

export async function refineCommand(idea: string, options: RefineOptions): Promise<void> {
  // Ensure global config exists
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig || !globalConfig.setup_complete) {
    console.log(chalk.yellow('Please run setup first: ai-phases config --setup'));
    process.exit(1);
  }
  
  // Check if project is initialized
  const projectConfig = await loadProjectConfig();
  if (!projectConfig) {
    console.log(chalk.yellow('Project not initialized. Run: ai-phases init'));
    process.exit(1);
  }
  
  console.log(
    boxen(
      chalk.bold.cyan('🔮 AI Phase Builder - Idea Refinement') +
      '\n\n' +
      chalk.dim('Transforming your idea into a structured project plan'),
      {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'magenta',
      }
    )
  );
  
  console.log(chalk.white('\n📝 Your idea:\n'));
  console.log(chalk.cyan(`  "${idea}"\n`));
  
  // Update state with original idea
  const state = await loadProjectState();
  if (state) {
    state.original_idea = idea;
    state.status = 'refining';
    await saveProjectState(state);
  }
  
  // Stage 1: Superprompt Enhancement
  console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow.bold('  🔮 STAGE 1: Superprompt Enhancement'));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  
  console.log(chalk.dim('Model: ') + chalk.cyan(globalConfig.cursor.planning_model));
  console.log(chalk.dim('Purpose: Expand and clarify your idea into a detailed spec\n'));
  
  const superprompt = generateSuperpromptEnhancement(idea, globalConfig);
  const superpromptPath = await savePromptToFile(superprompt);
  
  console.log(chalk.green('✓ Prompt generated: ') + chalk.dim(superpromptPath));
  
  if (globalConfig.cursor.context7_enabled && superprompt.context7Instructions) {
    console.log(chalk.dim('\nContext7 will look up:'));
    superprompt.context7Instructions.forEach(q => {
      console.log(chalk.dim('  • ') + chalk.white(q));
    });
  }
  
  // Show the prompt and instructions
  console.log(chalk.yellow('\n┌────────────────────────────────────────────────────────────┐'));
  console.log(chalk.yellow('│ ') + chalk.white.bold('Action Required') + chalk.yellow('                                           │'));
  console.log(chalk.yellow('├────────────────────────────────────────────────────────────┤'));
  console.log(chalk.yellow('│ ') + chalk.white('1. Open Cursor in this project') + chalk.yellow('                            │'));
  console.log(chalk.yellow('│ ') + chalk.white('2. Switch to Agent mode (Cmd+Shift+I)') + chalk.yellow('                     │'));
  console.log(chalk.yellow('│ ') + chalk.white(`3. Select model: ${globalConfig.cursor.planning_model.padEnd(20)}`) + chalk.yellow('          │'));
  console.log(chalk.yellow('│ ') + chalk.white('4. Paste the prompt (copied to clipboard)') + chalk.yellow('                 │'));
  console.log(chalk.yellow('│ ') + chalk.white('5. Run and review the enhanced specification') + chalk.yellow('              │'));
  console.log(chalk.yellow('└────────────────────────────────────────────────────────────┘\n'));
  
  // Copy prompt to clipboard
  const fullPrompt = buildCursorPrompt(superprompt);
  await copyToClipboard(fullPrompt);
  console.log(chalk.green('✓ Prompt copied to clipboard!\n'));
  
  // Also save full prompt for reference
  const promptRefPath = path.join(getProjectPhasesDir(), 'stage1-superprompt.md');
  await fs.writeFile(promptRefPath, fullPrompt);
  console.log(chalk.dim(`Full prompt saved to: ${promptRefPath}\n`));
  
  // Wait for user to complete stage 1
  const stage1Answer = await inquirer.prompt([
    {
      type: 'editor',
      name: 'enhanced_spec',
      message: 'Paste the enhanced specification from Cursor (opens editor):',
      default: '# Enhanced Project Specification\n\n[Paste Cursor output here]',
      waitForUseInput: true,
    },
  ]);
  
  if (!stage1Answer.enhanced_spec || stage1Answer.enhanced_spec.includes('[Paste Cursor output here]')) {
    console.log(chalk.yellow('\n⚠️  No enhanced spec provided. You can continue later with:'));
    console.log(chalk.cyan('  ai-phases refine "' + idea + '"'));
    return;
  }
  
  // Save enhanced spec
  const enhancedSpecPath = path.join(getProjectPhasesDir(), 'enhanced-spec.md');
  await fs.writeFile(enhancedSpecPath, stage1Answer.enhanced_spec);
  
  if (state) {
    state.enhanced_idea = stage1Answer.enhanced_spec;
    await saveProjectState(state);
  }
  
  console.log(chalk.green('\n✓ Enhanced specification saved!\n'));
  
  // Stage 2: Phase Structuring
  console.log(chalk.blue('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.blue.bold('  📋 STAGE 2: Phase Structuring'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  
  console.log(chalk.dim('Model: ') + chalk.cyan(globalConfig.cursor.planning_model));
  console.log(chalk.dim('Purpose: Break the spec into executable development phases\n'));
  
  const phasePrompt = generatePhaseStructuring(stage1Answer.enhanced_spec, globalConfig);
  const phasePromptPath = await savePromptToFile(phasePrompt);
  
  console.log(chalk.green('✓ Prompt generated: ') + chalk.dim(phasePromptPath));
  
  // Copy to clipboard
  const phaseFullPrompt = buildCursorPrompt(phasePrompt);
  await copyToClipboard(phaseFullPrompt);
  console.log(chalk.green('✓ Prompt copied to clipboard!\n'));
  
  // Save full prompt
  const phasePromptRefPath = path.join(getProjectPhasesDir(), 'stage2-phase-structuring.md');
  await fs.writeFile(phasePromptRefPath, phaseFullPrompt);
  
  console.log(chalk.yellow('\n┌────────────────────────────────────────────────────────────┐'));
  console.log(chalk.yellow('│ ') + chalk.white.bold('Action Required') + chalk.yellow('                                           │'));
  console.log(chalk.yellow('├────────────────────────────────────────────────────────────┤'));
  console.log(chalk.yellow('│ ') + chalk.white('1. Paste the new prompt in Cursor') + chalk.yellow('                         │'));
  console.log(chalk.yellow('│ ') + chalk.white('2. Review the generated phase plan') + chalk.yellow('                        │'));
  console.log(chalk.yellow('│ ') + chalk.white('3. Copy the phase plan back here') + chalk.yellow('                          │'));
  console.log(chalk.yellow('└────────────────────────────────────────────────────────────┘\n'));
  
  // Wait for phase plan
  const stage2Answer = await inquirer.prompt([
    {
      type: 'editor',
      name: 'phase_plan',
      message: 'Paste the phase plan from Cursor (opens editor):',
      default: '# Phase Plan\n\n[Paste Cursor output here]',
      waitForUseInput: true,
    },
  ]);
  
  if (!stage2Answer.phase_plan || stage2Answer.phase_plan.includes('[Paste Cursor output here]')) {
    console.log(chalk.yellow('\n⚠️  No phase plan provided. Run again when ready.'));
    return;
  }
  
  // Save phase plan
  const phasePlanPath = path.join(getProjectPhasesDir(), 'plan.md');
  await fs.writeFile(phasePlanPath, stage2Answer.phase_plan);
  
  // Parse phase plan and create phase states
  const spinner = ora('Processing phase plan...').start();
  
  try {
    const phases = parsePhasePlan(stage2Answer.phase_plan, globalConfig.defaults.max_retry_attempts);
    
    if (state) {
      state.phases = phases;
      state.total_phases = phases.length;
      state.current_phase = 1;
      state.status = 'in_progress';
      await saveProjectState(state);
    }
    
    // Create phase directories
    for (const phase of phases) {
      const phaseDir = path.join(getProjectPhasesDir(), 'phases', `phase-${phase.phase_number}`);
      await fs.ensureDir(phaseDir);
      await fs.writeJson(path.join(phaseDir, 'state.json'), phase, { spaces: 2 });
    }
    
    spinner.succeed('Phase plan processed!');
    
    // Show summary
    console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green.bold('  ✅ Project Plan Complete!'));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    console.log(chalk.white(`Project: ${state?.project_name || 'Unknown'}`));
    console.log(chalk.white(`Total Phases: ${phases.length}\n`));
    
    console.log(chalk.dim('Phase Overview:'));
    phases.forEach(p => {
      console.log(chalk.cyan(`  ${p.phase_number}. ${p.name}`));
      console.log(chalk.dim(`     ${p.tasks.length} tasks, ${p.validation_criteria.length} validation criteria`));
    });
    
    console.log(chalk.white('\nNext step:\n'));
    console.log(chalk.cyan('  ai-phases run --phase 1\n'));
    console.log(chalk.dim('Or view status with: ai-phases status\n'));
    
  } catch (error) {
    spinner.fail('Failed to process phase plan');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    console.log(chalk.yellow('\nThe phase plan has been saved. You can edit it at:'));
    console.log(chalk.cyan(`  ${phasePlanPath}`));
    console.log(chalk.yellow('\nThen run: ai-phases plan --from-file'));
  }
}

/**
 * Parse the phase plan markdown into structured phases
 */
function parsePhasePlan(planContent: string, maxAttempts: number): PhaseState[] {
  const phases: PhaseState[] = [];
  
  // Split by phase headers (## Phase N: Name)
  const phaseRegex = /##\s*Phase\s*(\d+):\s*(.+?)(?=##\s*Phase|\n##\s*Summary|$)/gis;
  const matches = [...planContent.matchAll(phaseRegex)];
  
  for (const match of matches) {
    const phaseNumber = parseInt(match[1], 10);
    const phaseName = match[2].trim();
    const phaseContent = match[0];
    
    // Extract description
    const descMatch = phaseContent.match(/\*\*Description\*\*:\s*(.+?)(?=\*\*|\n###|$)/is);
    const description = descMatch ? descMatch[1].trim() : phaseName;
    
    // Extract tasks
    const tasks: PhaseTask[] = [];
    const tasksSection = phaseContent.match(/###\s*Tasks\s*([\s\S]*?)(?=###|$)/i);
    if (tasksSection) {
      const taskLines = tasksSection[1].match(/^\d+\.\s*(.+)$/gm) || [];
      taskLines.forEach((line, index) => {
        const taskDesc = line.replace(/^\d+\.\s*/, '').trim();
        tasks.push({
          id: `task-${phaseNumber}-${index + 1}`,
          description: taskDesc,
          status: 'pending',
        });
      });
    }
    
    // Extract validation criteria
    const validationCriteria: string[] = [];
    const validationSection = phaseContent.match(/###\s*Validation\s*Criteria\s*([\s\S]*?)(?=###|$)/i);
    if (validationSection) {
      const criteriaLines = validationSection[1].match(/^-\s*\[.\]\s*(.+)$/gm) || [];
      criteriaLines.forEach(line => {
        const criterion = line.replace(/^-\s*\[.\]\s*/, '').trim();
        validationCriteria.push(criterion);
      });
    }
    
    // Extract Context7 queries
    const context7Queries: string[] = [];
    const context7Section = phaseContent.match(/###\s*Context7\s*Queries\s*([\s\S]*?)(?=###|##|$)/i);
    if (context7Section) {
      const queryLines = context7Section[1].match(/^-\s*(.+)$/gm) || [];
      queryLines.forEach(line => {
        const query = line.replace(/^-\s*/, '').trim();
        context7Queries.push(query);
      });
    }
    
    // Determine model based on phase content
    const modelMatch = phaseContent.match(/\*\*Model\*\*:\s*(.+)/i);
    const isPlanning = modelMatch 
      ? modelMatch[1].toLowerCase().includes('opus')
      : phaseNumber === 0;
    
    phases.push(createPhaseState(
      phaseNumber,
      phaseName,
      description,
      tasks.length > 0 ? tasks : [{ id: `task-${phaseNumber}-1`, description: 'Complete phase tasks', status: 'pending' }],
      validationCriteria.length > 0 ? validationCriteria : ['Phase objectives completed'],
      context7Queries,
      maxAttempts
    ));
    
    // Override model if explicitly specified
    if (!isPlanning && phases[phases.length - 1]) {
      phases[phases.length - 1].model = 'execution';
    }
  }
  
  // If no phases were parsed, create a default structure
  if (phases.length === 0) {
    console.log(chalk.yellow('⚠️  Could not parse phases from plan. Creating default structure.'));
    phases.push(createPhaseState(
      1,
      'Project Setup',
      'Initial project setup and configuration',
      [{ id: 'task-1-1', description: 'Complete initial setup', status: 'pending' }],
      ['Project runs successfully'],
      [],
      maxAttempts
    ));
  }
  
  return phases;
}

/**
 * Copy text to clipboard (cross-platform)
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    const platform = process.platform;
    let command: string;
    
    if (platform === 'darwin') {
      command = 'pbcopy';
    } else if (platform === 'linux') {
      command = 'xclip -selection clipboard';
    } else if (platform === 'win32') {
      command = 'clip';
    } else {
      return; // Unsupported platform
    }
    
    const child = await execAsync(`echo "${text.replace(/"/g, '\\"')}" | ${command}`);
  } catch {
    // Clipboard copy failed, but we already saved to file
  }
}
