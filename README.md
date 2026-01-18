# AI Phase Builder

Fully automated AI-powered project phase orchestration for Cursor IDE. Transform your ideas into structured, executable development phases that run automatically via the Cursor CLI.

## Features

- **Fully Automated** - No manual prompting or copy-paste. Everything runs via Cursor CLI
- **Idea Refinement Chain** - Turn rough ideas into comprehensive specs using Claude Opus
- **Phase Structuring** - Break projects into logical, executable phases
- **Smart Handovers** - Auto-generated context-aware transitions between phases
- **Rollback Support** - Retry failed phases with learned context (max 3 attempts)
- **Drift Detection** - Track manual changes made outside of phase runs
- **Context7 Integration** - Always use up-to-date documentation
- **Git Integration** - Auto-commit checkpoints for each phase

## Requirements

- Node.js 18+
- Cursor IDE with active subscription
- Cursor CLI (`cursor-agent`) installed
- Context7 MCP enabled (recommended)

## Installation

```bash
# Install Cursor CLI first
curl https://cursor.com/install -fsS | bash

# Global install of AI Phase Builder
npm install -g ai-phase-builder

# Or run directly
npx ai-phase-builder
```

## Quick Start

```bash
# First time setup - opens browser for Cursor login
ai-phases config --setup

# Initialize in your project
cd your-project
ai-phases init

# Transform your idea into a structured plan (fully automated)
ai-phases refine "build a crypto price dashboard with real-time updates"

# Run phases (fully automated)
ai-phases run --phase 1
ai-phases run --phase 2
# ...
```

## Commands

| Command | Description |
|---------|-------------|
| `ai-phases init` | Initialize AI Phase Builder in current project |
| `ai-phases refine <idea>` | Transform idea into enhanced spec + phase plan (automated) |
| `ai-phases plan` | Create or edit phase plan manually |
| `ai-phases run --phase N` | Execute a specific phase (automated) |
| `ai-phases status` | Show current project status |
| `ai-phases handover` | Generate handover summary for current phase (automated) |
| `ai-phases rollback` | Rollback a failed phase to retry |
| `ai-phases sync` | Detect and reconcile manual changes |
| `ai-phases config` | Manage configuration |

## How It Works

### 1. Idea Refinement Chain (Automated)

Your rough idea goes through a fully automated two-stage enhancement:

```
Your Idea → [Superprompt Enhancement] → [Phase Structuring] → Executable Plan
              Claude Opus (auto)         Claude Opus (auto)
```

No manual input required. The CLI runs both stages automatically via `cursor-agent`.

### 2. Model Routing

- **Claude Opus** - Planning, architecture decisions, complex reasoning
- **Gemini Flash** - Coding, code review, handover generation

All models are accessed through your Cursor subscription via the CLI.

### 3. Phase Execution (Fully Automated)

Each phase runs automatically:

```bash
ai-phases run --phase 1
# → cursor-agent executes the phase prompt
# → Changes are applied automatically
# → Handover is generated for next phase
# → Git checkpoint is created
```

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

### 4. Failure Handling

- Max 3 attempts per phase before blocking
- Failure reports capture what went wrong automatically
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
├── enhanced-spec.md  # AI-enhanced specification
├── phases/
│   ├── phase-1/
│   │   ├── state.json
│   │   ├── prompt.md
│   │   ├── handover.md
│   │   └── attempt-1/
│   │       ├── output.md
│   │       └── error.md (if failed)
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

### Cursor CLI Authentication

The tool uses Cursor's browser-based authentication - no API keys needed!

During setup, you'll be prompted to login:
```bash
ai-phases config --setup
# → Opens browser for Cursor login (one-time)
```

Or login manually anytime:
```bash
cursor-agent login   # Opens browser to authenticate
cursor-agent status  # Check if logged in
cursor-agent logout  # Sign out
```

## Context7 Integration

Context7 MCP provides up-to-date documentation directly in Cursor. Enable it:

1. Open Cursor Settings (Cmd+,)
2. Go to: Features → MCP Servers
3. Add Context7: https://context7.com/docs/clients/cursor
4. Restart Cursor

## Example Workflow

```bash
# 1. Start with an idea (runs automatically)
ai-phases refine "build a task management app with drag-and-drop"

# Output:
# ✓ Enhanced specification generated in 45s
# ✓ Phase plan generated in 32s
# ✓ 5 phases created
#
# Ready to execute! Run:
#   ai-phases run --phase 1

# 2. Execute phases (each runs automatically)
ai-phases run --phase 1
# → Phase executes via cursor-agent
# → Handover auto-generated
# → Git checkpoint created

ai-phases run --phase 2
ai-phases run --phase 3
# ...

# 3. If a phase fails, it auto-saves the error
ai-phases rollback --phase 3
ai-phases run --phase 3

# 4. Check status anytime
ai-phases status --verbose
```

## Dry Run Mode

Preview what will be executed without running:

```bash
ai-phases run --phase 1 --dry-run
```

## Troubleshooting

### "cursor-agent CLI not found"
Install the Cursor CLI:
```bash
curl https://cursor.com/install -fsS | bash
```

### "Not logged in to Cursor CLI"
Authenticate with your browser:
```bash
cursor-agent login
```

### Phase keeps failing
1. Check the error in `.ai-phases/phases/phase-N/attempt-X/error.md`
2. Use `ai-phases rollback --phase N` to reset
3. Consider simplifying the phase tasks in `plan.md`

## License

MIT
