import fs from 'fs-extra';
import path from 'path';
import { loadGlobalConfig, type GlobalConfig } from './config-manager.js';
import { loadProjectState, type PhaseState, type ProjectState } from './state-manager.js';
import { getProjectPhasesDir } from './config-manager.js';

export interface GeneratedPrompt {
  model: 'planning' | 'execution';
  modelName: string;
  stage: string;
  prompt: string;
  context7Lookups?: string[]; // Libraries to look up via Context7 MCP
}

/**
 * Stage 1: Superprompt Enhancement
 * Takes a rough idea and expands it into a comprehensive specification
 */
export function generateSuperpromptEnhancement(idea: string, config: GlobalConfig): GeneratedPrompt {
  // Extract explicit features from the idea for preservation
  const explicitFeatures = extractExplicitFeatures(idea);
  
  const prompt = `You are a senior software architect. Take this rough project idea and expand it into a comprehensive specification.

## Original Idea
${idea}

## CRITICAL: Feature Preservation
The following features were EXPLICITLY requested and MUST be included in the specification:
${explicitFeatures.map(f => `- ${f}`).join('\n')}

Do NOT omit, simplify, or defer any of these features. They are core requirements.

## Your Task
1. **Clarify the core purpose** - What problem does this solve? Who is the target user?
2. **Define features** - List ALL explicit features above, plus implicit features the user likely wants
3. **Set technical boundaries** - Suggest appropriate tech stack, identify what's NOT needed
4. **Scope boundaries** - What's included vs explicitly out of scope (explicit features are NEVER out of scope)
5. **Design direction** - Aesthetic, UX considerations

## Rules
- Don't over-engineer - keep it realistic for a solo developer
- Prefer established patterns over novel approaches
- If something is ambiguous, make a reasonable assumption and state it
- Output should be actionable, not theoretical
- NEVER mark an explicitly requested feature as "out of scope" or "future enhancement"

## Tech Stack Preferences
- UI Library: ${config.defaults.ui_library}
- Design System: ${config.defaults.design_system}

## Output Format
**CRITICAL: Output the ENTIRE specification as your response. Do NOT use any tools to save files.**
**Your response text IS the output - it will be captured and saved automatically.**

Provide a structured markdown specification with clear sections for:
- Project Overview
- Core Features (MUST include all explicit features listed above)
- Technical Stack
- Out of Scope (only things NOT mentioned in original idea)
- Design Direction

Be specific and concrete. This will be used to generate development phases.

**REMINDER: Do NOT use Write/Edit tools. Output the full specification as text in your response.**`;

  // Extract libraries to look up from the idea
  const context7Lookups = extractLibrariesToLookup(idea, config);
  
  return {
    model: 'planning',
    modelName: config.cursor.planning_model,
    stage: 'Superprompt Enhancement',
    prompt,
    context7Lookups,
  };
}

/**
 * Extract libraries/frameworks that should be looked up via Context7
 */
function extractLibrariesToLookup(idea: string, config: GlobalConfig): string[] {
  const libraries: string[] = [];
  const ideaLower = idea.toLowerCase();
  
  // Add configured UI library
  if (config.defaults.ui_library && config.defaults.ui_library !== 'none') {
    libraries.push(config.defaults.ui_library);
  }
  
  // Common frameworks/libraries to detect
  const libraryPatterns = [
    { pattern: /\b(next\.?js|nextjs)\b/i, lib: 'next.js' },
    { pattern: /\b(react)\b/i, lib: 'react' },
    { pattern: /\b(vue)\b/i, lib: 'vue' },
    { pattern: /\b(svelte)\b/i, lib: 'svelte' },
    { pattern: /\b(angular)\b/i, lib: 'angular' },
    { pattern: /\b(tailwind)\b/i, lib: 'tailwindcss' },
    { pattern: /\b(typescript|ts)\b/i, lib: 'typescript' },
    { pattern: /\b(express)\b/i, lib: 'express' },
    { pattern: /\b(prisma)\b/i, lib: 'prisma' },
    { pattern: /\b(supabase)\b/i, lib: 'supabase' },
    { pattern: /\b(firebase)\b/i, lib: 'firebase' },
    { pattern: /\b(mongodb|mongoose)\b/i, lib: 'mongodb' },
    { pattern: /\b(postgres|postgresql)\b/i, lib: 'postgresql' },
  ];
  
  for (const { pattern, lib } of libraryPatterns) {
    if (pattern.test(idea) && !libraries.includes(lib)) {
      libraries.push(lib);
    }
  }
  
  return libraries;
}

/**
 * Extract explicit features from the user's idea
 * Looks for specific mentions of functionality, sizes, modes, etc.
 */
function extractExplicitFeatures(idea: string): string[] {
  const features: string[] = [];
  const ideaLower = idea.toLowerCase();
  
  // Look for size/dimension patterns (e.g., "3x3", "5x5", "10x10")
  const sizePattern = /(\d+)\s*[x×]\s*(\d+)/gi;
  const sizeMatches = idea.match(sizePattern);
  if (sizeMatches) {
    features.push(`Board sizes: ${sizeMatches.join(', ')}`);
  }
  
  // Look for explicit feature keywords
  const featurePatterns = [
    { pattern: /\b(ai|computer|bot)\s*(opponent|player|mode)?\b/i, feature: 'AI/Computer opponent' },
    { pattern: /\b(multiplayer|multi-player|pvp|2\s*player)\b/i, feature: 'Multiplayer/PvP mode' },
    { pattern: /\b(score|scoring|points|leaderboard)\b/i, feature: 'Score tracking' },
    { pattern: /\b(dark\s*mode|light\s*mode|theme)\b/i, feature: 'Theme/Dark mode support' },
    { pattern: /\b(mobile|responsive)\b/i, feature: 'Mobile/Responsive design' },
    { pattern: /\b(save|persist|storage)\b/i, feature: 'Save/Persistence' },
    { pattern: /\b(undo|redo)\b/i, feature: 'Undo/Redo functionality' },
    { pattern: /\b(timer|timed|clock)\b/i, feature: 'Timer/Timed mode' },
    { pattern: /\b(sound|audio|music)\b/i, feature: 'Sound/Audio' },
    { pattern: /\b(animation|animated)\b/i, feature: 'Animations' },
    { pattern: /\b(modern|beautiful|sleek|polished)\b/i, feature: 'Modern/Polished UI' },
  ];
  
  for (const { pattern, feature } of featurePatterns) {
    if (pattern.test(idea)) {
      features.push(feature);
    }
  }
  
  // If no specific features detected, add the whole idea as a feature
  if (features.length === 0) {
    features.push(idea.trim());
  }
  
  return features;
}

/**
 * Stage 2: Phase Structuring
 * Takes the enhanced spec and breaks it into executable phases
 */
export function generatePhaseStructuring(enhancedSpec: string, config: GlobalConfig): GeneratedPrompt {
  const prompt = `You are a senior software architect. Take this project specification and break it into development phases.

## Project Specification
${enhancedSpec}

## CRITICAL: Feature Coverage
Every feature listed in "Core Features" above MUST be covered by at least one phase.
Do NOT defer features to "future work" or "nice to have" - they are all required.

## Your Task
Create a phased development plan where:
1. Each phase is independently executable and testable
2. Phases build on each other logically
3. Each phase has clear, VERIFIABLE validation criteria
4. ALL core features from the spec are assigned to specific phases

## Phase Structure Template
For each phase, provide:
- **Phase Number & Name**
- **Description**: What this phase accomplishes
- **Tasks**: Specific implementation tasks (3-7 per phase)
- **Validation Criteria**: TESTABLE criteria to verify completion (commands to run, UI elements to check, etc.)
- **Validation Commands**: Shell commands that should pass (e.g., \`npm run build\`, \`npm test\`, etc.)

## Validation Criteria Rules
Validation criteria must be VERIFIABLE, not subjective:
- ✅ Good: "Running \`npm run build\` completes without errors"
- ✅ Good: "The 5x5 board option is visible and selectable in the UI"
- ✅ Good: "Clicking a cell places the current player's mark"
- ❌ Bad: "Code is clean and well-organized"
- ❌ Bad: "UI looks good"

## Rules
- Phase 1 should always be project foundation/setup
- Keep phases focused (4-8 hours of work each)
- Earlier phases should not depend on later phases
- Include a final phase for polish and testing
- Maximum 10 phases for any project
- EVERY feature in the spec must appear in at least one phase's tasks

## Output Format
**CRITICAL INSTRUCTIONS - READ CAREFULLY:**
1. **DO NOT use Write, Edit, or any file tools** - Your text response IS the output
2. **DO NOT save files** - The system will capture your response and save it
3. **Output the ENTIRE plan** - From "# Phase Plan" header through "## Summary"
4. **Start your response with "# Phase Plan"** - No preamble or explanation

Provide the COMPLETE phase plan in this exact markdown structure (output ALL of this):

# Phase Plan

## Phase 1: [Name]
**Description**: [One paragraph]
**Model**: Gemini Flash

### Tasks
1. [Task 1]
2. [Task 2]
...

### Validation Criteria
- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]
...

### Validation Commands
\`\`\`bash
npm run build
npm run lint
# any other commands that should pass
\`\`\`

(Repeat for each phase - include ALL phases in your response)

## Summary
- Total Phases: [N]
- Estimated Total Time: [X hours]
- Features Covered: [List all features from spec and which phase covers them]

**REMINDER: Do NOT use Write/Edit tools. Output the full plan as text in your response.**`;

  return {
    model: 'planning',
    modelName: config.cursor.planning_model,
    stage: 'Phase Structuring',
    prompt,
    context7Lookups: ['react', 'typescript'], // Common for most web projects
  };
}

/**
 * Generate prompt for executing a specific phase
 * 
 * CONTEXT STRATEGY (Clean Context per Phase):
 * - Each phase starts with MINIMAL context
 * - Only loads: phase info + previous handover + Context7 docs
 * - Full project spec and research findings are NOT included
 * - This keeps prompts efficient and focused
 */
export async function generatePhaseExecutionPrompt(
  phase: PhaseState,
  previousHandover?: string
): Promise<GeneratedPrompt> {
  const config = await loadGlobalConfig();
  if (!config) throw new Error('No global config found');

  // NOTE: We intentionally DO NOT load the full project state here
  // Each phase should work from handover context only, not the full spec
  
  let prompt = `# Phase ${phase.phase_number}: ${phase.name}

## Phase Context
${phase.description}

`;

  // Add previous handover ONLY (summarized context from last phase)
  // This is the ONLY carry-over context between phases
  if (previousHandover) {
    prompt += `## Handover from Previous Phase
${summarizeForContext(previousHandover)}

`;
  } else if (phase.phase_number === 1) {
    prompt += `## Note
This is the first phase. No previous context to load.

`;
  }

  // Add tasks for THIS phase only
  prompt += `## Tasks
${phase.tasks.map((t, i) => `${i + 1}. ${t.description}`).join('\n')}

`;

  // Add validation checklist
  prompt += `## Validation Checklist
Complete ALL before marking phase done:
${phase.validation_criteria.map(c => `- [ ] ${c}`).join('\n')}

`;

  // Context7 libraries to look up for this phase
  const context7Libraries = phase.context7_libraries || [];

  // Minimal design constraints
  prompt += `## Constraints
- UI: ${config.defaults.ui_library}
- Design: ${config.defaults.design_system}
- Follow existing codebase patterns

## CRITICAL Technical Requirements
**Framer Motion (motion/react):**
- When using \`Variants\` type, use typed easings: \`ease: [0.4, 0, 0.2, 1]\` (cubic bezier) instead of \`ease: "easeOut"\`
- Or import and use: \`import type { Transition } from "motion/react"\` with proper casting
- Always test that TypeScript compiles without errors

**Tailwind CSS v4 + shadcn/ui:**
- Do NOT use \`@apply\` with CSS variable-based utilities like \`border-border\` - use inline classes instead
- If globals.css has \`@theme\` block, CSS variables are defined there
- Use direct color values in \`@layer base\` instead of \`@apply\`

`;

  // Rules - keep focused
  prompt += `## Rules
- Only modify files relevant to THIS phase
- Don't refactor unrelated code
- Complete all validation criteria before finishing
- Note any blockers in handover

`;

  // If retry, add ONLY the failure context (not full history)
  if (phase.current_attempt > 0) {
    const failureReportPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phase.phase_number}`,
      `attempt-${phase.current_attempt}`,
      'failure-report.md'
    );
    
    if (await fs.pathExists(failureReportPath)) {
      const failureReport = await fs.readFile(failureReportPath, 'utf-8');
      prompt += `## ⚠️ Retry Attempt ${phase.current_attempt + 1}/${phase.max_attempts}

### What Failed Last Time
${summarizeForContext(failureReport)}

**Fix the above issues before proceeding.**

`;
    }
  }

  return {
    model: 'execution',
    modelName: config.cursor.execution_model,
    stage: `Phase ${phase.phase_number} Execution`,
    prompt,
    context7Lookups: context7Libraries,
  };
}

/**
 * Summarize content for context injection
 * Implements "forget gates" - strips unnecessary detail
 */
function summarizeForContext(content: string, maxLines: number = 50): string {
  const lines = content.split('\n');
  
  // If short enough, return as-is
  if (lines.length <= maxLines) {
    return content;
  }
  
  // Otherwise, extract key sections only
  const summarized: string[] = [];
  let currentSection = '';
  let linesInSection = 0;
  const maxLinesPerSection = 10;
  
  for (const line of lines) {
    // Keep all headers
    if (line.startsWith('#')) {
      currentSection = line;
      linesInSection = 0;
      summarized.push(line);
    }
    // Keep first few lines of each section
    else if (linesInSection < maxLinesPerSection) {
      // Skip empty lines at start of section
      if (line.trim() || linesInSection > 0) {
        summarized.push(line);
        linesInSection++;
      }
    }
    // Add truncation marker once per section
    else if (linesInSection === maxLinesPerSection) {
      summarized.push('  [...truncated for brevity...]');
      linesInSection++;
    }
  }
  
  return summarized.join('\n');
}

/**
 * Generate handover summary prompt
 * 
 * IMPORTANT: Handovers should be CONCISE because they're the ONLY
 * context passed to the next phase. Keep it focused and scannable.
 */
export async function generateHandoverPrompt(phase: PhaseState): Promise<GeneratedPrompt> {
  const config = await loadGlobalConfig();
  if (!config) throw new Error('No global config found');

  const prompt = `Generate a **concise** handover for Phase ${phase.phase_number}: ${phase.name}

## Format (Keep Each Section Brief)

### ✅ Done
- Bullet points only
- What was built/implemented (3-5 items max)

### 📁 Key Files
| File | Purpose |
|------|---------|
| path | one-line description |
(Only list files the next phase needs to know about)

### ⚠️ Watch Out
- Gotchas or non-obvious things
- Known issues if any
- Things that might break

### 📋 Validation
${phase.validation_criteria.map(c => `- [ ] ${c}`).join('\n')}

## Rules
- **MAX 30 lines total** - this goes directly into next phase's context
- No fluff, no obvious statements
- If nothing to report in a section, skip it
- Focus on what the NEXT phase needs to know`;

  return {
    model: 'execution',
    modelName: config.cursor.execution_model,
    stage: 'Handover Generation',
    prompt,
  };
}

/**
 * Build the full prompt with cursor instructions
 * Includes Context7 MCP instructions when libraries need to be looked up
 */
export function buildCursorPrompt(generated: GeneratedPrompt): string {
  let fullPrompt = '';
  
  // Add model instruction header
  fullPrompt += `---
Model: ${generated.modelName}
Stage: ${generated.stage}
---

`;
  
  // Add Context7 lookup instructions if there are libraries to look up
  if (generated.context7Lookups && generated.context7Lookups.length > 0) {
    fullPrompt += `## Documentation Lookup (Context7)
**Before proceeding, use @context7 to look up current documentation for:**
${generated.context7Lookups.map(lib => `- ${lib}: latest setup guide and best practices`).join('\n')}

This ensures you have up-to-date API references and avoid deprecated patterns.

---

`;
  }
  
  fullPrompt += generated.prompt;
  
  return fullPrompt;
}

/**
 * Save generated prompt to file
 */
export async function savePromptToFile(
  prompt: GeneratedPrompt,
  phaseNumber?: number,
  attemptNumber?: number
): Promise<string> {
  const phasesDir = getProjectPhasesDir();
  let promptPath: string;
  
  if (phaseNumber !== undefined && attemptNumber !== undefined) {
    promptPath = path.join(
      phasesDir,
      'phases',
      `phase-${phaseNumber}`,
      `attempt-${attemptNumber}`,
      'prompt.md'
    );
  } else if (phaseNumber !== undefined) {
    promptPath = path.join(phasesDir, 'phases', `phase-${phaseNumber}`, 'prompt.md');
  } else {
    promptPath = path.join(phasesDir, `${prompt.stage.toLowerCase().replace(/\s+/g, '-')}-prompt.md`);
  }
  
  await fs.ensureDir(path.dirname(promptPath));
  await fs.writeFile(promptPath, buildCursorPrompt(prompt));
  
  return promptPath;
}
