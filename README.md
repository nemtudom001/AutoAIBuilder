# AI Phase Builder

Fully automated AI-powered project phase orchestration for Cursor IDE. Transform your ideas into structured, executable development phases that run automatically via the Cursor CLI.

## Features

- **100% Hands-Off** - Just describe your idea, everything else is automated
- **Auto-Run All Phases** - Phases execute sequentially without intervention
- **Auto GitHub Repo** - Creates private GitHub repo and pushes automatically
- **Idea Refinement Chain** - Turn rough ideas into comprehensive specs using Claude Opus
- **Phase Structuring** - Break projects into logical, executable phases
- **Smart Handovers** - Auto-generated context-aware transitions between phases
- **Rollback Support** - Retry failed phases with learned context (max 3 attempts)
- **Drift Detection** - Track manual changes made outside of phase runs
- **Context7 Integration** - Always use up-to-date documentation
- **Git Integration** - Auto-commit and auto-push after each phase

---

## Installation

### Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 18+ | Runtime |
| Cursor IDE | Active subscription | AI models |
| Git | Any recent version | Version control |
| GitHub CLI (`gh`) | Any recent version | Auto repo creation |

### Step 1: Install AI Phase Builder

```bash
npm install -g ai-phase-builder
```

### Step 2: Install GitHub CLI

GitHub CLI is required for automatic repository creation. The setup wizard will prompt you to authenticate.

<details>
<summary><strong>🪟 Windows</strong></summary>

```powershell
# Using winget (recommended)
winget install --id GitHub.cli

# Or download from: https://cli.github.com/
```

</details>

<details>
<summary><strong>🍎 macOS</strong></summary>

```bash
# Using Homebrew
brew install gh
```

</details>

<details>
<summary><strong>🐧 Linux</strong></summary>

```bash
# Ubuntu/Debian
sudo apt install gh

# Or using conda
conda install gh --channel conda-forge
```

</details>

> **Note:** You don't need to run `gh auth login` manually - the setup wizard will prompt you to authenticate.

### Step 3: Install Cursor CLI

The Cursor CLI (`cursor-agent`) requires a Unix-like environment. Follow the instructions for your operating system (Windows users: install inside WSL):

<details>
<summary><strong>🪟 Windows (WSL Required)</strong></summary>

Windows users must use **WSL (Windows Subsystem for Linux)** to run `cursor-agent`.

#### 2a. Install WSL (if not already installed)

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

This installs Ubuntu by default. **Restart your computer** when prompted.

#### 2b. Set up WSL environment

After restart, open **Ubuntu** from Start menu. It will complete setup and ask you to create a username/password.

Then run these commands in the Ubuntu terminal:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install curl (if not present)
sudo apt install curl -y

# Install Cursor CLI
curl https://cursor.com/install -fsS | bash

# Add to PATH (run this line exactly)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verify installation
cursor-agent --version
```

#### ✅ Done! 

You can now use `ai-phases` from any Windows terminal (CMD, PowerShell, or Git Bash). The tool automatically routes commands through WSL.

</details>

<details>
<summary><strong>🍎 macOS</strong></summary>

Open Terminal and run:

```bash
# Install Cursor CLI
curl https://cursor.com/install -fsS | bash

# Add to PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Verify installation
cursor-agent --version
```

</details>

<details>
<summary><strong>🐧 Linux</strong></summary>

Open terminal and run:

```bash
# Install Cursor CLI
curl https://cursor.com/install -fsS | bash

# Add to PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verify installation
cursor-agent --version
```

</details>

> **Note:** You don't need to run `cursor-agent login` manually - the setup wizard will prompt you to authenticate.

### Step 4: Create Your First Project

```bash
# Create project folder
mkdir my-project && cd my-project

# Initialize (runs setup wizard on first use)
ai-phases init
```

On first run, `init` will automatically run the setup wizard which:
- Verifies Cursor CLI installation → **prompts to login if needed**
- Verifies GitHub CLI installation → **prompts to authenticate if needed**
- Configures your preferences (UI library, design system)
- Sets up automation options (auto-run, auto-commit, auto-push)

All authentication happens during setup, before any AI generation starts!

---

## Quick Start

After prerequisites are installed, it's just 3 commands:

```bash
# 1. Create project folder
mkdir my-project && cd my-project

# 2. Initialize (setup wizard runs automatically on first use)
ai-phases init

# 3. ONE COMMAND does everything:
ai-phases refine "build a crypto price dashboard with real-time updates"
```

That's it! The tool will:
1. Generate enhanced specification (Claude Opus)
2. Create phase plan with tasks
3. Create private GitHub repo
4. Run ALL phases automatically
5. Commit & push after each phase
6. Generate handovers between phases

### Want Manual Control?

```bash
# Generate plan without auto-running phases
ai-phases refine "your idea" --no-auto-run

# Then run phases individually
ai-phases run --phase 1
ai-phases run --phase 2
```

---

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
| `ai-phases config` | Manage configuration (use `--setup` to reconfigure) |

---

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
# → Auto-continues to next phase (if enabled)
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

---

## Configuration

Global config stored at: `~/.ai-phase-builder/config.json`

```json
{
  "cursor": {
    "planning_model": "opus-4.5",
    "execution_model": "gemini-3-flash",
    "context7_enabled": true
  },
  "defaults": {
    "ui_library": "shadcn",
    "design_system": "vercel",
    "auto_commit": true,
    "auto_push": true,
    "auto_run_phases": true,
    "auto_create_repo": true,
    "github_visibility": "private",
    "max_retry_attempts": 3
  }
}
```

### Automation Options

| Option | Default | Description |
|--------|---------|-------------|
| `auto_run_phases` | `true` | Automatically run all phases after `refine` |
| `auto_create_repo` | `true` | Create GitHub repo automatically |
| `github_visibility` | `private` | Repo visibility (private/public) |
| `auto_commit` | `true` | Commit after each phase |
| `auto_push` | `true` | Push to remote after each commit |

---

## Context7 Integration (Recommended)

Context7 MCP provides up-to-date documentation directly in Cursor. Enable it:

1. Open Cursor Settings (Cmd+, or Ctrl+,)
2. Go to: Features → MCP Servers
3. Add Context7: https://context7.com/docs/clients/cursor
4. Restart Cursor

---

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

---

## Troubleshooting

### "cursor-agent CLI not found"

<details>
<summary><strong>Windows</strong></summary>

The tool requires WSL with `cursor-agent` installed inside it.

1. **Check WSL is installed:**
   ```powershell
   wsl --list
   ```
   Should show "Ubuntu" (or another distro).

2. **Check cursor-agent is installed in WSL:**
   ```bash
   wsl -d Ubuntu -e bash -c "cursor-agent --version"
   ```

3. **If not installed, follow the Windows installation steps above.**

</details>

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
# Reinstall
curl https://cursor.com/install -fsS | bash

# Add to PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc  # or ~/.zshrc for macOS
source ~/.bashrc  # or source ~/.zshrc

# Verify
cursor-agent --version
```

</details>

### "Not logged in to Cursor CLI"

```bash
# Windows (run in any terminal)
wsl -d Ubuntu -e bash -c "cursor-agent login"

# macOS / Linux
cursor-agent login
```

### "GitHub CLI not authenticated"

```bash
# Run this and follow the prompts
gh auth login

# Verify authentication
gh auth status
```

### "Failed to create GitHub repository"

1. Ensure GitHub CLI is installed: `gh --version`
2. Ensure you're authenticated: `gh auth status`
3. Check if repo name already exists on your GitHub

### Phase keeps failing

1. Check the error in `.ai-phases/phases/phase-N/attempt-X/error.md`
2. Use `ai-phases rollback --phase N` to reset
3. Consider simplifying the phase tasks in `plan.md`

### WSL not starting properly (Windows)

```powershell
# Restart WSL
wsl --shutdown
wsl

# If that doesn't work, reset WSL
wsl --unregister Ubuntu
wsl --install -d Ubuntu
```

### "Permission denied" errors

```bash
# Make cursor-agent executable
chmod +x ~/.local/bin/cursor-agent
```

---

## Example Workflow

```bash
# 1. Create project
mkdir my-dashboard && cd my-dashboard
ai-phases init

# 2. Start with an idea (runs automatically)
ai-phases refine "build a task management app with drag-and-drop"

# Output:
# ✓ Enhanced specification generated
# ✓ Phase plan generated (5 phases)
# ✓ GitHub repo created
# ✓ Running phase 1...
# ✓ Phase 1 complete
# ✓ Running phase 2...
# ... continues automatically ...
# 🎉 All phases complete!

# 3. Check status anytime
ai-phases status
```

---

## Dry Run Mode

Preview what will be executed without running:

```bash
ai-phases run --phase 1 --dry-run
```

---

## FAQ

**Q: Does this work without Cursor subscription?**
No. The tool uses `cursor-agent` which requires an active Cursor subscription.

**Q: Why WSL on Windows?**
The `cursor-agent` CLI doesn't have native Windows support. WSL provides a Linux environment that works seamlessly.

**Q: Can I use this with other AI tools?**
Currently, this is designed specifically for Cursor IDE. The architecture could be extended for other tools in the future.

**Q: How much does it cost?**
The tool itself is free. You only pay for your Cursor subscription (which provides access to Claude Opus and Gemini Flash).

---

## License

MIT
