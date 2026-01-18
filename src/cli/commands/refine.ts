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
  runPlanningTask,
  isCursorCliInstalled,
  extractMarkdown,
} from '../../core/cursor-cli.js';
import {
  isGitRepo,
  initGitRepo,
  createGitHubRepo,
} from '../../core/git-integration.js';
import { runCommand } from './run.js';

interface RefineOptions {
  skipResearch?: boolean;
  noAutoRun?: boolean;
}

export async function refineCommand(idea: string, options: RefineOptions): Promise<void> {
  // Ensure global config exists
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig || !globalConfig.setup_complete) {
    console.log(chalk.yellow('Please run setup first: ai-phases config --setup'));
    process.exit(1);
  }
  
  // Check if CLI is available - if not, use manual mode
  const cliInstalled = await isCursorCliInstalled();
  const useManualMode = !cliInstalled;
  
  if (useManualMode) {
    console.log(chalk.yellow('\n⚠️  Cursor CLI (agent) not found - using manual mode.\n'));
    console.log(chalk.dim('Prompts will be saved to files for you to run manually in Cursor IDE.\n'));
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
  
  // Run Stage 1 automatically
  const spinner1 = ora({
    text: 'Enhancing your idea with AI...',
    spinner: 'dots12',
  }).start();
  
  const startTime1 = Date.now();
  const fullPrompt1 = buildCursorPrompt(superprompt);
  
  const stage1Result = await runPlanningTask(fullPrompt1);
  const elapsed1 = Math.round((Date.now() - startTime1) / 1000);
  
  // Handle manual mode - CLI not available
  if (stage1Result.manualMode) {
    spinner1.info('Manual mode - prompt saved');
    console.log(chalk.cyan('\n📋 MANUAL MODE\n'));
    console.log(chalk.white('The Cursor CLI is not available. Please complete this task manually:\n'));
    console.log(chalk.dim('1. Open the prompt file in Cursor IDE:'));
    console.log(chalk.cyan(`   ${stage1Result.promptPath}\n`));
    console.log(chalk.dim('2. Select all the content and use Cursor\'s AI (Ctrl+K or Cmd+K)'));
    console.log(chalk.dim('3. Save the AI\'s response to:'));
    console.log(chalk.cyan(`   ${path.join(getProjectPhasesDir(), 'enhanced-spec.md')}\n`));
    console.log(chalk.dim('4. Then run the refine command again to continue:\n'));
    console.log(chalk.cyan(`   ai-phases refine "${idea}"\n`));
    process.exit(0);
  }
  
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
  
  // Handle manual mode - CLI not available
  if (stage2Result.manualMode) {
    spinner2.info('Manual mode - prompt saved');
    console.log(chalk.cyan('\n📋 MANUAL MODE\n'));
    console.log(chalk.white('Please complete this task manually:\n'));
    console.log(chalk.dim('1. Open the prompt file in Cursor IDE:'));
    console.log(chalk.cyan(`   ${stage2Result.promptPath}\n`));
    console.log(chalk.dim('2. Select all the content and use Cursor\'s AI (Ctrl+K or Cmd+K)'));
    console.log(chalk.dim('3. Save the AI\'s response to:'));
    console.log(chalk.cyan(`   ${path.join(getProjectPhasesDir(), 'plan.md')}\n`));
    console.log(chalk.dim('4. Then run plan command to process it:\n'));
    console.log(chalk.cyan('   ai-phases plan --from-file\n'));
    process.exit(0);
  }
  
  if (!stage2Result.success) {
    spinner2.fail(`Stage 2 failed after ${elapsed2}s`);
    console.log(chalk.red('\nError: ') + chalk.dim(stage2Result.error || 'Unknown error'));
    console.log(chalk.yellow('\nThe enhanced spec has been saved. Retry phase structuring later.'));
    process.exit(1);
  }
  
  spinner2.succeed(`Phase plan generated in ${elapsed2}s`);
  
  // Extract and save phase plan
  let phasePlan = extractMarkdown(stage2Result.output);
  const phasePlanPath = path.join(getProjectPhasesDir(), 'plan.md');
  
  // Log output size for debugging
  console.log(chalk.dim(`Output received: ${stage2Result.output.length} chars, extracted: ${phasePlan.length} chars`));
  
  await fs.writeFile(phasePlanPath, phasePlan);
  console.log(chalk.green('✓ Saved: ') + chalk.dim(phasePlanPath));
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Process Phase Plan
  // ═══════════════════════════════════════════════════════════════════════════
  const spinner3 = ora('Processing phase plan...').start();
  
  try {
    let phases = parsePhasePlan(phasePlan, globalConfig.defaults.max_retry_attempts);
    
    // Detect truncated output - if we only got 1 phase and it's not named "Project Setup" or has weird numbering
    const looksTruncated = phases.length === 1 && !phasePlan.includes('## Phase 1:');
    
    // Fallback 1: Check if AI wrote to phases.md
    if (phases.length <= 1 || looksTruncated) {
      const alternatePhaseFile = path.join(getProjectPhasesDir(), 'phases.md');
      if (await fs.pathExists(alternatePhaseFile)) {
        const alternatePlan = await fs.readFile(alternatePhaseFile, 'utf-8');
        const altPhases = parsePhasePlan(alternatePlan, globalConfig.defaults.max_retry_attempts);
        if (altPhases.length > phases.length) {
          console.log(chalk.dim('Found detailed plan in phases.md, using that instead.'));
          phasePlan = alternatePlan;
          phases = altPhases;
          await fs.writeFile(phasePlanPath, phasePlan);
        }
      }
    }
    
    // Fallback 2: Check for any .md files created by the AI in the project
    if (phases.length <= 1 || looksTruncated) {
      const possiblePlanFiles = ['plan.md', 'project-plan.md', 'phase-plan.md'];
      for (const filename of possiblePlanFiles) {
        const possiblePath = path.join(process.cwd(), filename);
        if (await fs.pathExists(possiblePath)) {
          const altContent = await fs.readFile(possiblePath, 'utf-8');
          if (altContent.includes('## Phase 1:') && altContent.includes('## Phase 2:')) {
            const altPhases = parsePhasePlan(altContent, globalConfig.defaults.max_retry_attempts);
            if (altPhases.length > phases.length) {
              console.log(chalk.dim(`Found detailed plan in ${filename}, using that.`));
              phasePlan = altContent;
              phases = altPhases;
              await fs.writeFile(phasePlanPath, phasePlan);
              break;
            }
          }
        }
      }
    }
    
    // Warn if output looks truncated
    if (phases.length === 1 && looksTruncated) {
      console.log(chalk.yellow('⚠️  Warning: Output may have been truncated. Only 1 phase detected.'));
      console.log(chalk.dim('If this seems wrong, check .ai-phases/plan.md and re-run refine.'));
    }
    
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
    
    // Auto-create GitHub repo if enabled
    if (globalConfig.defaults.auto_create_repo) {
      console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.yellow.bold('  📦 Setting up GitHub Repository'));
      console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
      
      const repoResult = await createGitHubRepo(
        state?.project_name || path.basename(process.cwd()),
        globalConfig.defaults.github_visibility
      );
      
      if (!repoResult.success) {
        console.log(chalk.yellow(`⚠️  ${repoResult.error}`));
        console.log(chalk.dim('Continuing without remote repository...\n'));
      }
    }
    
    // Auto-run all phases if enabled and not disabled via flag
    if (globalConfig.defaults.auto_run_phases && !options.noAutoRun) {
      console.log(chalk.magenta('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.magenta.bold('  🤖 Auto-Running All Phases'));
      console.log(chalk.magenta('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
      console.log(chalk.dim('Full automation enabled. Running all phases sequentially...\n'));
      
      // Sort phases by phase_number and iterate over them directly
      const sortedPhases = [...phases].sort((a, b) => a.phase_number - b.phase_number);
      
      for (let idx = 0; idx < sortedPhases.length; idx++) {
        const currentPhase = sortedPhases[idx];
        const phaseNum = currentPhase.phase_number;
        
        console.log(chalk.cyan(`\n▶ Starting Phase ${idx + 1}/${sortedPhases.length}: ${currentPhase.name}\n`));
        
        try {
          // runCommand with auto:true will return instead of process.exit
          await runCommand({ phase: String(phaseNum), auto: true });
          
          // Check if phase completed or blocked
          const updatedState = await loadProjectState();
          const updatedPhase = updatedState?.phases.find(p => p.phase_number === phaseNum);
          
          if (updatedPhase?.status === 'blocked') {
            console.log(chalk.red(`\n⛔ Phase ${phaseNum} is blocked. Stopping auto-run.`));
            console.log(chalk.dim('Fix the issue and run: ai-phases run --phase ' + phaseNum));
            break;
          }
          
          if (updatedPhase?.status !== 'completed') {
            console.log(chalk.yellow(`\n⚠️  Phase ${phaseNum} did not complete successfully. Stopping auto-run.`));
            break;
          }
        } catch (error) {
          console.log(chalk.red(`\n✗ Phase ${phaseNum} encountered an error. Stopping auto-run.`));
          console.log(chalk.dim(error instanceof Error ? error.message : 'Unknown error'));
          break;
        }
      }
      
      // Final status
      const finalState = await loadProjectState();
      if (finalState?.status === 'completed') {
        console.log(chalk.green('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.green.bold('  🎉 ALL PHASES COMPLETE!'));
        console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
        console.log(chalk.white('Your project is ready!'));
        console.log(chalk.dim('View details with: ai-phases status\n'));
      } else {
        console.log(chalk.dim('\nView current status with: ai-phases status\n'));
      }
    } else {
      console.log(chalk.white('\n🚀 Ready to execute! Run:\n'));
      console.log(chalk.cyan('  ai-phases run --phase 1\n'));
      console.log(chalk.dim('Or view full status with: ai-phases status\n'));
    }
    
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
  
  // First, strip any AI preamble before the actual plan
  // Look for "# Phase Plan" header as the start of actual content
  let contentToProcess = planContent;
  const phasePlanMatch = planContent.match(/^#\s*Phase\s*Plan\s*$/im);
  if (phasePlanMatch && phasePlanMatch.index !== undefined) {
    // Start processing from the "# Phase Plan" header
    contentToProcess = planContent.substring(phasePlanMatch.index);
  }
  
  // Split content by phase headers to get each phase section
  const phaseSections = contentToProcess.split(/(?=##\s*Phase\s*\d+:)/i);
  
  // Track sequential phase number (always start from 1)
  let sequentialPhaseNum = 0;
  
  for (const section of phaseSections) {
    // Match the phase header to get number and name
    const headerMatch = section.match(/##\s*Phase\s*(\d+):\s*(.+)/i);
    if (!headerMatch) continue;
    
    // Increment sequential counter - this ensures phases are always 1, 2, 3...
    sequentialPhaseNum++;
    const phaseNumber = sequentialPhaseNum;
    const phaseName = headerMatch[2].trim();
    const phaseContent = section;
    
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
    const validationSection = phaseContent.match(/###\s*Validation\s*Criteria\s*([\s\S]*?)(?=###|##|$)/i);
    if (validationSection) {
      // Match both checkbox format "- [ ]" and plain list "- "
      const criteriaLines = validationSection[1].match(/^-\s*(?:\[.\]\s*)?(.+)$/gm) || [];
      criteriaLines.forEach(line => {
        const criterion = line.replace(/^-\s*(?:\[.\]\s*)?/, '').trim();
        if (criterion) {
          validationCriteria.push(criterion);
        }
      });
    }
    
    // Extract validation commands from code blocks
    const validationCommands: string[] = [];
    const commandsSection = phaseContent.match(/###\s*Validation\s*Commands\s*([\s\S]*?)(?=###|##|$)/i);
    if (commandsSection) {
      // Look for code block
      const codeBlockMatch = commandsSection[1].match(/```(?:bash|sh)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        const commands = codeBlockMatch[1]
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#')); // Skip empty lines and comments
        validationCommands.push(...commands);
      }
    }
    
    // Also extract inline commands from validation criteria (e.g., "Running `npm run build` completes...")
    validationCriteria.forEach(criterion => {
      const inlineCommands = criterion.match(/`([^`]+)`/g);
      if (inlineCommands) {
        inlineCommands.forEach(cmd => {
          const cleanCmd = cmd.replace(/`/g, '').trim();
          // Only add if it looks like a runnable command
          if (cleanCmd.startsWith('npm ') || cleanCmd.startsWith('npx ') || 
              cleanCmd.startsWith('yarn ') || cleanCmd.startsWith('pnpm ')) {
            if (!validationCommands.includes(cleanCmd)) {
              validationCommands.push(cleanCmd);
            }
          }
        });
      }
    });
    
    // Extract Context7 libraries to look up (from phase content)
    const context7Libraries = extractContext7Libraries(phaseContent, tasks);
    
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
      validationCommands,
      context7Libraries,
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
      ['npm run build'],
      ['react', 'typescript'],
      maxAttempts
    ));
  }
  
  return phases;
}

/**
 * Extract libraries/frameworks that should be looked up via Context7 for a phase
 */
function extractContext7Libraries(phaseContent: string, tasks: PhaseTask[]): string[] {
  const libraries: string[] = [];
  const contentLower = phaseContent.toLowerCase();
  const taskText = tasks.map(t => t.description).join(' ').toLowerCase();
  const allText = contentLower + ' ' + taskText;
  
  // Common libraries to detect
  const libraryPatterns = [
    { pattern: /\b(next\.?js|nextjs)\b/i, lib: 'next.js' },
    { pattern: /\b(react)\b/i, lib: 'react' },
    { pattern: /\b(vue)\b/i, lib: 'vue' },
    { pattern: /\b(svelte)\b/i, lib: 'svelte' },
    { pattern: /\b(tailwind|tailwindcss)\b/i, lib: 'tailwindcss' },
    { pattern: /\b(shadcn)\b/i, lib: 'shadcn/ui' },
    { pattern: /\b(typescript)\b/i, lib: 'typescript' },
    { pattern: /\b(vite)\b/i, lib: 'vite' },
    { pattern: /\b(vitest)\b/i, lib: 'vitest' },
    { pattern: /\b(jest)\b/i, lib: 'jest' },
    { pattern: /\b(prisma)\b/i, lib: 'prisma' },
    { pattern: /\b(drizzle)\b/i, lib: 'drizzle' },
    { pattern: /\b(trpc)\b/i, lib: 'trpc' },
    { pattern: /\b(zod)\b/i, lib: 'zod' },
    { pattern: /\b(framer.motion)\b/i, lib: 'framer-motion' },
    { pattern: /\b(zustand)\b/i, lib: 'zustand' },
    { pattern: /\b(redux)\b/i, lib: 'redux' },
  ];
  
  for (const { pattern, lib } of libraryPatterns) {
    if (pattern.test(allText) && !libraries.includes(lib)) {
      libraries.push(lib);
    }
  }
  
  return libraries;
}
