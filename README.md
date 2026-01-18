# AI Phase Builder 🚀

AI-powered project phase orchestration for Cursor IDE. Transform your ideas into structured, executable development phases with intelligent handovers and rollback support.

## Features

- **🔮 Idea Refinement Chain** - Turn rough ideas into comprehensive specs using Claude Opus
- **📋 Phase Structuring** - Break projects into logical, executable phases
- **🔄 Smart Handovers** - Context-aware transitions between phases with summarization
- **↩️ Rollback Support** - Retry failed phases with learned context (max 3 attempts)
- **🔍 Drift Detection** - Track manual changes made outside of phase runs
- **📚 Context7 Integration** - Always use up-to-date documentation
- **💾 Git Integration** - Auto-commit checkpoints for each phase

## Requirements

- Node.js 18+
- Cursor IDE with active subscription
- Context7 MCP enabled (recommended)

## Installation

```bash
# Global install
npm install -g ai-phase-builder

# Or run directly
npx ai-phase-builder
```

## Quick Start

```bash
# First time setup (zero API keys needed!)
ai-phases config --setup

# Initialize in your project
cd your-project
ai-phases init

# Transform your idea into a structured plan
ai-phases refine "build a crypto price dashboard with real-time updates"

# Run phases
ai-phases run --phase 1
```

## Commands

| Command | Description |
|---------|-------------|
| `ai-phases init` | Initialize AI Phase Builder in current project |
| `ai-phases refine <idea>` | Transform idea into enhanced spec + phase plan |
| `ai-phases plan` | Create or edit phase plan manually |
| `ai-phases run --phase N` | Execute a specific phase |
| `ai-phases status` | Show current project status |
| `ai-phases handover` | Generate handover summary for current phase |
| `ai-phases rollback` | Rollback a failed phase to retry |
| `ai-phases sync` | Detect and reconcile manual changes |
| `ai-phases config` | Manage configuration |

## How It Works

### 1. Idea Refinement Chain

Your rough idea goes through a three-stage enhancement process:

```
Your Idea → [Superprompt Enhancement] → [Phase Structuring] → Executable Plan
              (Claude Opus)             (Claude Opus)
```

### 2. Model Routing

- **Claude Opus** - Planning, architecture decisions, complex reasoning
- **Gemini Flash** - Coding, code review, handover generation

All models are accessed through your Cursor subscription - no additional API keys needed!

### 3. Phase Execution & Clean Context

Each phase runs with **minimal, focused context**:

```
Phase N Context (ONLY these):
├── Phase description + tasks
├── Validation checklist
├── Handover from Phase N-1 (summarized)
├── Context7 docs (fetched fresh)
└── Failure report (if retrying)

NOT included (cleared):
├── Full project specification
├── Research findings
├── Context from Phase N-2 and earlier
└── Previous attempt details (except failures)
```

This "clean context" approach:
- Keeps prompts efficient (~500-1000 tokens vs 5000+)
- Prevents context pollution across phases
- Forces handovers to capture essential info
- Lets Context7 provide fresh documentation each phase

### 4. Failure Handling

- Max 3 attempts per phase before blocking
- Failure reports capture what went wrong
- Rollback notes guide the next attempt
- Blocked phases require manual intervention

## Project Structure

When initialized, creates:

```
.ai-phases/
├── config.json       # Project settings
├── state.json        # Phase tracking state
├── context.md        # Persistent project context
├── plan.md           # Master phase plan
├── phases/
│   ├── phase-1/
│   │   ├── state.json
│   │   ├── prompt.md
│   │   ├── handover.md
│   │   └── attempt-1/
│   └── phase-2/
│       └── ...
├── logs/
│   └── drift.log
└── templates/
    ├── handover.md
    ├── failure-report.md
    └── phase-prompt.md
```

## Configuration

Global config stored at: `~/.ai-phase-builder/config.json`

```json
{
  "cursor": {
    "planning_model": "claude-opus-4.5",
    "execution_model": "gemini-3-flash",
    "context7_enabled": true
  },
  "defaults": {
    "ui_library": "shadcn",
    "design_system": "vercel",
    "auto_commit": true,
    "max_retry_attempts": 3
  }
}
```

## Context7 Integration

Context7 MCP provides up-to-date documentation directly in Cursor. Enable it:

1. Open Cursor Settings (Cmd+,)
2. Go to: Features → MCP Servers
3. Add Context7: https://context7.com/docs/clients/cursor
4. Restart Cursor

## Example Workflow

```bash
# 1. Start with an idea
ai-phases refine "build a task management app with drag-and-drop"

# 2. Review and approve the generated plan
# 3. Execute phases one by one
ai-phases run --phase 1
ai-phases handover --phase 1
ai-phases run --phase 2
# ...

# 4. If a phase fails
ai-phases rollback --phase 3
ai-phases run --phase 3

# 5. Check status anytime
ai-phases status --verbose
```

## License

MIT
