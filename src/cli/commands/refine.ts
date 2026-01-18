import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
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
import {
  runCursorAgent,
  runPlanningTask,
  isCursorCliInstalled,
  getCursorApiKey,
  extractMarkdown,
} from '../../core/cursor-cli.js';

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
      chalk.dim('Fully automated via Cursor CLI'),
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
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 1: Superprompt Enhancement (Automated)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow.bold('  🔮 STAGE 1: Superprompt Enhancement'));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  
  console.log(chalk.dim('Model: ') + chalk.cyan(globalConfig.cursor.planning_model));
  console.log(chalk.dim('Purpose: Expand and clarify your idea into a detailed spec\n'));
  
  const superprompt = generateSuperpromptEnhancement(idea, globalConfig);
  const superpromptPath = await savePromptToFile(superprompt);
  console.log(chalk.dim('Prompt saved: ') + chalk.white(superpromptPath));
  
  if (globalConfig.cursor.context7_enabled && superprompt.context7Instructions) {
    console.log(chalk.dim('\nContext7 will look up:'));
    superprompt.context7Instructions.forEach(q => {
      console.log(chalk.dim('  • ') + chalk.white(q));
    });
  }
  
  // Run Stage 1 automatically
  const spinner1 = ora({
    text: 'Enhancing your idea with AI...',
    spinner: 'dots12',
  }).start();
  
  const startTime1 = Date.now();
  const fullPrompt1 = buildCursorPrompt(superprompt);
  
  const stage1Result = await runPlanningTask(fullPrompt1);
  const elapsed1 = Math.round((Date.now() - startTime1) / 1000);
  
  if (!stage1Result.success) {
    spinner1.fail(`Stage 1 failed after ${elapsed1}s`);
    console.log(chalk.red('\nError: ') + chalk.dim(stage1Result.error || 'Unknown error'));
    console.log(chalk.yellow('\nRetry with: ai-phases refine "' + idea + '"'));
    process.exit(1);
  }
  
  spinner1.succeed(`Enhanced specification generated in ${elapsed1}s`);
  
  // Extract and save enhanced spec
  const enhancedSpec = extractMarkdown(stage1Result.output);
  const enhancedSpecPath = path.join(getProjectPhasesDir(), 'enhanced-spec.md');
  await fs.writeFile(enhancedSpecPath, enhancedSpec);
  console.log(chalk.green('✓ Saved: ') + chalk.dim(enhancedSpecPath));
  
  if (state) {
    state.enhanced_idea = enhancedSpec;
    await saveProjectState(state);
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 2: Phase Structuring (Automated)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.blue('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.blue.bold('  📋 STAGE 2: Phase Structuring'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  
  console.log(chalk.dim('Model: ') + chalk.cyan(globalConfig.cursor.planning_model));
  console.log(chalk.dim('Purpose: Break the spec into executable development phases\n'));
  
  const phasePrompt = generatePhaseStructuring(enhancedSpec, globalConfig);
  const phasePromptPath = await savePromptToFile(phasePrompt);
  console.log(chalk.dim('Prompt saved: ') + chalk.white(phasePromptPath));
  
  // Run Stage 2 automatically
  const spinner2 = ora({
    text: 'Structuring project into phases...',
    spinner: 'dots12',
  }).start();
  
  const startTime2 = Date.now();
  const fullPrompt2 = buildCursorPrompt(phasePrompt);
  
  const stage2Result = await runPlanningTask(fullPrompt2);
  const elapsed2 = Math.round((Date.now() - startTime2) / 1000);
  
  if (!stage2Result.success) {
    spinner2.fail(`Stage 2 failed after ${elapsed2}s`);
    console.log(chalk.red('\nError: ') + chalk.dim(stage2Result.error || 'Unknown error'));
    console.log(chalk.yellow('\nThe enhanced spec has been saved. Retry phase structuring later.'));
    process.exit(1);
  }
  
  spinner2.succeed(`Phase plan generated in ${elapsed2}s`);
  
  // Extract and save phase plan
  const phasePlan = extractMarkdown(stage2Result.output);
  const phasePlanPath = path.join(getProjectPhasesDir(), 'plan.md');
  await fs.writeFile(phasePlanPath, phasePlan);
  console.log(chalk.green('✓ Saved: ') + chalk.dim(phasePlanPath));
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Process Phase Plan
  // ═══════════════════════════════════════════════════════════════════════════
  const spinner3 = ora('Processing phase plan...').start();
  
  try {
    const phases = parsePhasePlan(phasePlan, globalConfig.defaults.max_retry_attempts);
    
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
    
    spinner3.succeed('Phase plan processed!');
    
    // Show summary
    const totalTime = elapsed1 + elapsed2;
    console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green.bold('  ✅ Project Plan Complete!'));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    
    console.log(chalk.white(`Project: ${state?.project_name || 'Unknown'}`));
    console.log(chalk.white(`Total Phases: ${phases.length}`));
    console.log(chalk.dim(`Generated in: ${totalTime}s\n`));
    
    console.log(chalk.dim('Phase Overview:'));
    phases.forEach(p => {
      console.log(chalk.cyan(`  ${p.phase_number}. ${p.name}`));
      console.log(chalk.dim(`     ${p.tasks.length} tasks, ${p.validation_criteria.length} validation criteria`));
    });
    
    console.log(chalk.white('\n🚀 Ready to execute! Run:\n'));
    console.log(chalk.cyan('  ai-phases run --phase 1\n'));
    console.log(chalk.dim('Or view full status with: ai-phases status\n'));
    
  } catch (error) {
    spinner3.fail('Failed to process phase plan');
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
