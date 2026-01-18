import fs from 'fs-extra';
import path from 'path';
import { getProjectPhasesDir } from './config-manager.js';

export interface PhaseTask {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  notes?: string;
}

export interface PhaseState {
  phase_number: number;
  name: string;
  description: string;
  model: 'planning' | 'execution';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  current_attempt: number;
  max_attempts: number;
  tasks: PhaseTask[];
  validation_criteria: string[];
  validation_commands?: string[]; // Shell commands to verify completion
  context7_libraries?: string[]; // Libraries to look up via Context7 MCP
  started_at?: string;
  completed_at?: string;
}

export interface AttemptState {
  attempt_number: number;
  started_at: string;
  completed_at?: string;
  status: 'in_progress' | 'completed' | 'failed';
  error_summary?: string;
  suggested_fix?: string;
  files_modified: string[];
  tokens_used?: {
    input: number;
    output: number;
  };
}

export interface ProjectState {
  project_name: string;
  created_at: string;
  updated_at: string;
  original_idea: string;
  enhanced_idea?: string;
  total_phases: number;
  current_phase: number;
  status: 'planning' | 'refining' | 'in_progress' | 'completed' | 'blocked';
  phases: PhaseState[];
  research_findings?: string;
  design_tokens?: Record<string, string>;
  git_base_commit?: string;
}

export async function loadProjectState(): Promise<ProjectState | null> {
  try {
    const statePath = path.join(getProjectPhasesDir(), 'state.json');
    if (await fs.pathExists(statePath)) {
      return await fs.readJson(statePath);
    }
  } catch {
    // State doesn't exist or is invalid
  }
  return null;
}

export async function saveProjectState(state: ProjectState): Promise<void> {
  const statePath = path.join(getProjectPhasesDir(), 'state.json');
  state.updated_at = new Date().toISOString();
  await fs.ensureDir(path.dirname(statePath));
  await fs.writeJson(statePath, state, { spaces: 2 });
}

export async function createInitialState(projectName: string, idea: string): Promise<ProjectState> {
  const state: ProjectState = {
    project_name: projectName,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    original_idea: idea,
    total_phases: 0,
    current_phase: 0,
    status: 'planning',
    phases: [],
  };
  
  await saveProjectState(state);
  return state;
}

export async function loadPhaseState(phaseNumber: number): Promise<PhaseState | null> {
  const state = await loadProjectState();
  if (!state) return null;
  
  return state.phases.find(p => p.phase_number === phaseNumber) || null;
}

export async function updatePhaseState(phaseNumber: number, updates: Partial<PhaseState>): Promise<void> {
  const state = await loadProjectState();
  if (!state) throw new Error('No project state found');
  
  const phaseIndex = state.phases.findIndex(p => p.phase_number === phaseNumber);
  if (phaseIndex === -1) throw new Error(`Phase ${phaseNumber} not found`);
  
  state.phases[phaseIndex] = { ...state.phases[phaseIndex], ...updates };
  await saveProjectState(state);
}

export async function loadAttemptState(phaseNumber: number, attemptNumber: number): Promise<AttemptState | null> {
  try {
    const attemptPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      `attempt-${attemptNumber}`,
      'state.json'
    );
    if (await fs.pathExists(attemptPath)) {
      return await fs.readJson(attemptPath);
    }
  } catch {
    // Attempt state doesn't exist
  }
  return null;
}

export async function saveAttemptState(
  phaseNumber: number,
  attemptNumber: number,
  attemptState: AttemptState
): Promise<void> {
  const attemptPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'state.json'
  );
  await fs.ensureDir(path.dirname(attemptPath));
  await fs.writeJson(attemptPath, attemptState, { spaces: 2 });
}

export async function createNewAttempt(phaseNumber: number): Promise<AttemptState> {
  const phase = await loadPhaseState(phaseNumber);
  if (!phase) throw new Error(`Phase ${phaseNumber} not found`);
  
  const attemptNumber = phase.current_attempt + 1;
  
  if (attemptNumber > phase.max_attempts) {
    throw new Error(`Maximum attempts (${phase.max_attempts}) exceeded for phase ${phaseNumber}`);
  }
  
  const attemptState: AttemptState = {
    attempt_number: attemptNumber,
    started_at: new Date().toISOString(),
    status: 'in_progress',
    files_modified: [],
  };
  
  await saveAttemptState(phaseNumber, attemptNumber, attemptState);
  await updatePhaseState(phaseNumber, { current_attempt: attemptNumber, status: 'in_progress' });
  
  return attemptState;
}

export async function markAttemptFailed(
  phaseNumber: number,
  attemptNumber: number,
  errorSummary: string,
  suggestedFix: string
): Promise<void> {
  const attemptState = await loadAttemptState(phaseNumber, attemptNumber);
  if (!attemptState) throw new Error(`Attempt ${attemptNumber} not found for phase ${phaseNumber}`);
  
  attemptState.status = 'failed';
  attemptState.completed_at = new Date().toISOString();
  attemptState.error_summary = errorSummary;
  attemptState.suggested_fix = suggestedFix;
  
  await saveAttemptState(phaseNumber, attemptNumber, attemptState);
  
  // Save failure report
  const failureReportPath = path.join(
    getProjectPhasesDir(),
    'phases',
    `phase-${phaseNumber}`,
    `attempt-${attemptNumber}`,
    'failure-report.md'
  );
  
  const failureReport = `# Failure Report - Phase ${phaseNumber}, Attempt ${attemptNumber}

## Date
${new Date().toISOString()}

## What Was Attempted
[Details from the attempt]

## Why It Failed
${errorSummary}

## Suggested Fix for Next Attempt
${suggestedFix}

## Files Modified During This Attempt
${attemptState.files_modified.map(f => `- ${f}`).join('\n') || 'None recorded'}
`;
  
  await fs.writeFile(failureReportPath, failureReport);
  
  // Check if max attempts reached
  const phase = await loadPhaseState(phaseNumber);
  if (phase && phase.current_attempt >= phase.max_attempts) {
    await updatePhaseState(phaseNumber, { status: 'blocked' });
    
    // Create BLOCKED.md
    const blockedPath = path.join(
      getProjectPhasesDir(),
      'phases',
      `phase-${phaseNumber}`,
      'BLOCKED.md'
    );
    
    const blockedContent = `# ⛔ Phase ${phaseNumber} BLOCKED

This phase has failed after ${phase.max_attempts} attempts.

## Summary of All Attempts

${Array.from({ length: phase.max_attempts }, (_, i) => i + 1)
  .map(n => `### Attempt ${n}\nSee: attempt-${n}/failure-report.md`)
  .join('\n\n')}

## Recommendation
Manual intervention required. Consider:
1. Reviewing the architecture decisions
2. Breaking this phase into smaller phases
3. Adjusting the requirements

## To Unblock
Run: \`ai-phases config --unblock ${phaseNumber}\`
`;
    
    await fs.writeFile(blockedPath, blockedContent);
    
    // Update project status
    const state = await loadProjectState();
    if (state) {
      state.status = 'blocked';
      await saveProjectState(state);
    }
  } else {
    await updatePhaseState(phaseNumber, { status: 'failed' });
  }
}

export async function markAttemptCompleted(
  phaseNumber: number,
  attemptNumber: number,
  filesModified: string[]
): Promise<void> {
  const attemptState = await loadAttemptState(phaseNumber, attemptNumber);
  if (!attemptState) throw new Error(`Attempt ${attemptNumber} not found for phase ${phaseNumber}`);
  
  attemptState.status = 'completed';
  attemptState.completed_at = new Date().toISOString();
  attemptState.files_modified = filesModified;
  
  await saveAttemptState(phaseNumber, attemptNumber, attemptState);
  await updatePhaseState(phaseNumber, { 
    status: 'completed',
    completed_at: new Date().toISOString()
  });
}

export async function getPhaseDirectory(phaseNumber: number): Promise<string> {
  return path.join(getProjectPhasesDir(), 'phases', `phase-${phaseNumber}`);
}

export async function getCurrentPhaseInfo(): Promise<{
  phase: PhaseState;
  attempt: AttemptState | null;
  canRetry: boolean;
} | null> {
  const state = await loadProjectState();
  if (!state || state.phases.length === 0) return null;
  
  const currentPhase = state.phases.find(p => p.phase_number === state.current_phase);
  if (!currentPhase) return null;
  
  const currentAttempt = currentPhase.current_attempt > 0
    ? await loadAttemptState(currentPhase.phase_number, currentPhase.current_attempt)
    : null;
  
  const canRetry = currentPhase.current_attempt < currentPhase.max_attempts;
  
  return {
    phase: currentPhase,
    attempt: currentAttempt,
    canRetry,
  };
}

export function createPhaseState(
  phaseNumber: number,
  name: string,
  description: string,
  tasks: PhaseTask[],
  validationCriteria: string[],
  validationCommands: string[],
  context7Libraries: string[] = [],
  maxAttempts: number = 3
): PhaseState {
  return {
    phase_number: phaseNumber,
    name,
    description,
    model: phaseNumber === 0 ? 'planning' : 'execution',
    status: 'pending',
    current_attempt: 0,
    max_attempts: maxAttempts,
    tasks,
    validation_criteria: validationCriteria,
    validation_commands: validationCommands,
    context7_libraries: context7Libraries,
  };
}
