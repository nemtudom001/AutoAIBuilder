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
  context7Instructions?: string[];
}

/**
 * Stage 1: Superprompt Enhancement
 * Takes a rough idea and expands it into a comprehensive specification
 */
export function generateSuperpromptEnhancement(idea: string, config: GlobalConfig): GeneratedPrompt {
  const prompt = `You are a senior software architect. Take this rough project idea and expand it into a comprehensive specification.

## Original Idea
${idea}

## Your Task
1. **Clarify the core purpose** - What problem does this solve? Who is the target user?
2. **Define features** - List explicit AND implicit features the user likely wants
3. **Set technical boundaries** - Suggest appropriate tech stack, identify what's NOT needed
4. **Scope boundaries** - What's included vs explicitly out of scope
5. **Design direction** - Aesthetic, UX considerations

## Rules
- Don't over-engineer - keep it realistic for a solo developer
- Prefer established patterns over novel approaches
- If something is ambiguous, make a reasonable assumption and state it
- Output should be actionable, not theoretical

## Tech Stack Preferences
- UI Library: ${config.defaults.ui_library}
- Design System: ${config.defaults.design_system}

## Output Format
Provide a structured markdown specification with clear sections for:
- Project Overview
- Core Features
- Technical Stack
- Out of Scope
- Design Direction

Be specific and concrete. This will be used to generate development phases.`;

  return {
    model: 'planning',
    modelName: config.cursor.planning_model,
    stage: 'Superprompt Enhancement',
    prompt,
    context7Instructions: [
      'Look up the latest documentation for suggested frameworks',
      'Verify current best practices for the tech stack',
    ],
  };
}

/**
 * Stage 2: Phase Structuring
 * Takes the enhanced spec and breaks it into executable phases
 */
export function generatePhaseStructuring(enhancedSpec: string, config: GlobalConfig): GeneratedPrompt {
  const prompt = `You are a senior software architect. Take this project specification and break it into development phases.

## Project Specification
${enhancedSpec}

## Your Task
Create a phased development plan where:
1. Each phase is independently executable and testable
2. Phases build on each other logically
3. Each phase has clear validation criteria
4. Context7 documentation queries are specified for each phase

## Phase Structure Template
For each phase, provide:
- **Phase Number & Name**
- **Description**: What this phase accomplishes
- **Tasks**: Specific implementation tasks (3-7 per phase)
- **Validation Criteria**: How to verify this phase is complete
- **Context7 Queries**: Documentation to look up before starting

## Rules
- Phase 1 should always be project foundation/setup
- Keep phases focused (4-8 hours of work each)
- Earlier phases should not depend on later phases
- Include a final phase for polish and testing
- Maximum 10 phases for any project

## Output Format
Provide the phase plan in this exact markdown structure:

# Phase Plan

## Phase 1: [Name]
**Description**: [One paragraph]
**Model**: Gemini Flash

### Tasks
1. [Task 1]
2. [Task 2]
...

### Validation Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]
...

### Context7 Queries
- [library/framework]: [specific topic to look up]
...

(Repeat for each phase)

## Summary
- Total Phases: [N]
- Estimated Total Time: [X hours]`;

  return {
    model: 'planning',
    modelName: config.cursor.planning_model,
    stage: 'Phase Structuring',
    prompt,
    context7Instructions: [
      'Verify framework setup best practices',
      'Check for any recent breaking changes in dependencies',
    ],
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

  // Context7 - fetch FRESH docs for this phase (not cached from previous)
  if (phase.context7_queries && phase.context7_queries.length > 0) {
    prompt += `## Documentation (Context7)
**Before coding**, use @context7 to fetch current docs for:
${phase.context7_queries.map(q => `- ${q}`).join('\n')}

This ensures you have up-to-date API references.

`;
  }

  // Minimal design constraints
  prompt += `## Constraints
- UI: ${config.defaults.ui_library}
- Design: ${config.defaults.design_system}
- Follow existing codebase patterns

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
    context7Instructions: phase.context7_queries,
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
 */
export function buildCursorPrompt(generated: GeneratedPrompt): string {
  let fullPrompt = '';
  
  // Add model instruction header
  fullPrompt += `---
Model: ${generated.modelName}
Stage: ${generated.stage}
---

`;
  
  // Add Context7 instructions if present
  if (generated.context7Instructions && generated.context7Instructions.length > 0) {
    fullPrompt += `**Before starting, use @context7 to look up:**
${generated.context7Instructions.map(q => `- ${q}`).join('\n')}

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
