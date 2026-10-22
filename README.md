# Qwen Workspace

A desktop coding workspace for Windows, powered by **Qwen**. It has a file explorer, a VS Code–style editor (Monaco), a terminal, and a Qwen chat panel that can read, search and edit your project. Every edit and command needs your approval.

## Download

Grab the latest build from the [Releases page](https://github.com/MrRobotto512/Qwen-Workspace/releases): the installer, a portable `.exe`, or a zip. The builds aren't code-signed, so Windows SmartScreen may warn you the first time. Click **More info → Run anyway**.

## Features

- **Build from scratch:**
  - Ask for something new ("help me make a Switch homebrew app"), or use **Start from scratch** on the home screen.
  - Qwen asks what only you can answer with `ask_user`. Click a suggested answer or type your own, in the question card or the message box.
  - It researches the toolchain with `web_search` and `fetch_url`, preferring official docs and repositories.
  - It saves what it learns (toolchain, build commands, links) to `QWEN.md`, so later conversations start with it.
  - Search uses DuckDuckGo without a key, or Brave Search / SearXNG (**Settings → Research**).
  - Pages on this PC or your local network can't be fetched unless you allow it, because web content can try to steer the AI.
- **Conversations & task history:**
  - Every conversation or agent task is saved per project.
  - The **History** panel lists them by Today / Yesterday / Earlier, with status (running, needs approval, done, failed, stopped) and how many files each changed. Search, rename or delete them.
  - Reopen any of them to see the full transcript and keep going; Qwen remembers the earlier messages.
  - Start a **new conversation** (`Ctrl+N`) while another task keeps running in the background. A badge and the "needs you" pill show when a background task is waiting for approval.
- **Models for this PC:**
  - Detects your GPU, VRAM, RAM and CPU.
  - Rates each Qwen model as fast (fits in GPU memory), usable (partly on CPU), slow, or too large, and picks a context window that fits.
  - Marks the best choice as **Recommended**.
  - Downloads models through Ollama inside the app, with progress.

  Open it from the model menu (top right) or **Settings → Find models**.
- **Long context with YaRN:**
  - Most Qwen models are trained on 32K tokens. YaRN stretches their position encoding to read up to 128K.
  - Ollama can't turn YaRN on by itself, so the **Long context (YaRN)** tab in **Models for this PC** offers builds with YaRN built in (Unsloth's 128K GGUFs on Hugging Face), downloaded through Ollama.
  - For each model, it plans the largest context that fits this PC's memory and sets it when you click **Use**.
  - Qwen3-Coder 30B is natively 256K, so it just gets a bigger context window, with no YaRN build needed.
  - The app warns when the context window is set beyond what the current model handles, and suggests a YaRN build when a conversation is running out of room.

  Qwen notes YaRN can slightly lower quality on short prompts. Use these builds for big tasks and keep a standard model for everyday work.
- **Built-in updates:** the app checks GitHub Releases on startup and every 6 hours.
  - The **installed** version downloads the update in the background and installs it on restart.
  - The **portable** .exe and the zip open the download page instead.
- **Follow Qwen:**
  - The editor opens files as Qwen reads them.
  - Edits Qwen makes stay highlighted in the editor.
  - Edits that need your approval appear as a full-size diff with **Approve** / **Reject**.
- **Changes panel:** every file the current conversation created or edited, with added/removed line counts. Click one to see its diff, or revert it. Reverting only undoes that conversation's changes.
- **Git built in:** clone a repo from the home screen, and commit (with an AI-written message) and push from the Changes panel. If Git isn't on your PC, the app offers to download a portable copy into its own folder — no separate install and no admin rights — so clone, commit and push just work.
- **Approval modes** (in the message box):
  - **Ask:** approve every edit and command.
  - **Auto-edit** (default): edits apply right away, and commands ask unless you've marked them "Always allow".
  - **Full auto:** nothing asks.

  Destructive commands such as `rm -rf`, `del /s` or `git push` always ask.
- **Workspace:**
  - Explorer, project search (`Ctrl+Shift+F`) and go to file (`Ctrl+P`).
  - Monaco editor with tabs.
  - Terminal panel.
  - Home screen with quick actions and recent folders.
- **Qwen chat:**
  - Streaming answers with a collapsible thought process.
  - Each tool call shows as one compact line ("Read main.c · 120 lines ✓"); click it to open the file or diff.
  - Attaches the open file and your selection as context.
  - Code blocks get **Copy**, **Insert** and **Apply** buttons.
  - A context meter shows how full Qwen's memory is.
- **Agent tools:**
  - Always available: `list_files`, `read_file`, `search_code`, `edit_file`, `write_file`, `run_command`, `todo_write`, `ask_user`, `install_app`, plus `web_search` and `fetch_url` unless research is turned off.
  - On demand: `load_skill` (when the project has skills), `install_git`, and `delete_file` / `move_file`, which Qwen loads with `tool_search` when needed.
  - **Install apps by asking:** say "install iTunes" (or VLC, Chrome, VS Code…) and Qwen installs it with **winget**, the Windows Package Manager, after your approval. If winget isn't on the PC, it says so; for Git it falls back to `install_git`, which downloads a portable Git into the app's folder with no winget and no admin rights.
  - Independent lookups in one reply run in parallel; edits and commands run one at a time.
- **Automations:** recurring agent tasks — "every morning at 9, run the tests and fix simple failures", "every 4 hours, sweep TODOs". Set them up in **Settings → Automations** (every N hours, or daily at a time with catch-up on launch). Each runs in the project it was created for while the app is open, shows up in History with a ⏱ title, and can be paused, run now, or deleted.
- **Per-conversation model switch:** a model chip in the message box flips just that conversation between your default local Qwen, the planner model (e.g. Gemini), or any installed Ollama model — no trip to Settings. Messages driven by a non-default model carry a badge.
- **Planner handoff (two models):**
  - Let a local Qwen do the grunt work and hand the hard parts to a stronger "planner" model (e.g. Gemini 2.5 Pro, or another Qwen in the cloud). Set it up in **Settings → Planner (heavy model) handoff**.
  - When Qwen stalls — repeating steps without progress — the next step runs on the planner automatically to break the impasse, then control returns to Qwen.
  - Qwen can also ask the planner for help on demand with a `consult_planner` tool (a design decision, a tricky bug, a review), and uses the advice to keep working locally.
  - A small badge on a message shows when it ran on the planner. The planner's requests go to that provider and use its quota/billing; the grunt work stays on your local model.
- **MCP servers (external tools):**
  - Add servers in **Settings → Tools & MCP servers** (a command like `npx -y rea-agents mcp`, or an `https://` URL).
  - Their tools join Qwen's toolset as `mcp__<server>__<tool>`. Like the other extra tools, Qwen loads them with `tool_search` only when a task needs them, so a big server doesn't crowd the tool list.
  - Each MCP call needs your approval (with an "Always allow" option per server). The status bar shows how many servers and tools are connected.
  - Works with any MCP server, e.g. [REA](https://github.com/morluto/rea) for reverse engineering. Node-based servers need Node.js installed.
- **Workflows:**
  - Bundled starter setups you install into a project from the home screen.
  - **Software factory:** adapted from the [multi-agent original](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code) for a single local model. Say "run the factory: <feature>" and Qwen runs it through spec → build → review (code + security) → decide, on its own git branch, writing a record of each stage under `factory/jobs/`. Nothing is merged or pushed without you asking.
- **Project memory and skills:**
  - Put standing instructions for Qwen in `QWEN.md` (or `AGENTS.md`) at the project root.
  - Put task-specific instructions in `.qwen/skills/<name>/SKILL.md`. Personal skills that apply to every project go in `%APPDATA%\qwen-workspace\skills\`.
  - **Claude-format skills work as-is:** the project's `.claude/skills` and your personal `~/.claude/skills` are picked up too, so skills made for Claude Code run here unchanged.
  - **Install from GitHub:** in **Settings → Skills**, paste a link to a repo or to a folder containing `SKILL.md` (e.g. `…/tree/main/skills/my-skill`) and click Install.
  - Qwen sees only each skill's name and description, and loads the rest when a task calls for it.
- **Plan and compaction:**
  - For multi-step tasks, Qwen keeps a plan (shown above the message box).
  - When a conversation nears the context window, older turns are summarized automatically. Click the context meter to summarize now.
- **Loop protection:** if Qwen repeats the exact same lookup, the app skips it and tells Qwen to move on. If it keeps stalling, Qwen is nudged to finish or ask a question. A task stops after a set number of steps (Settings → Agent, default 60) so a loop can't run forever; the stop message has a one-click **Continue**.

## 1. Get a Qwen model running

### Option A: Ollama (free, local, private)

1. Install Ollama from https://ollama.com/download.
2. Pull a Qwen coding model that fits your GPU:

   ```powershell
   ollama pull qwen2.5-coder:7b     # ~5 GB, good for 8 GB+ VRAM
   ollama pull qwen2.5-coder:14b    # better, needs ~12 GB VRAM
   ollama pull qwen3-coder:30b      # best local option if you have the memory
   ```

3. In the app, open the model menu (top right) → **Models for this PC** and download the recommended model. Or pull one yourself with the commands above.

The app talks to Ollama's own API and sets the context window itself (32,768 tokens by default; change it under **⚙ → Context window**). Use a lower value if Ollama runs out of GPU memory. The status line under the chat shows how much of the window is in use.

### Option B: LM Studio

Download a Qwen2.5-Coder or Qwen3-Coder model, then start the local server from the **Developer** tab (port 1234). For long context, download one of Unsloth's "128K" GGUFs (search for, say, `Qwen2.5-Coder-14B-Instruct-128K`). They have YaRN built in; raise the context length when loading the model.

### Option C: Cloud API

Use a cloud model when you want more capability than your PC can run locally. Pick the provider in **Settings → Provider**, paste your API key, click **Fetch models** and choose one:
- **Google Gemini** — a strong coder with a very large context window. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey); good default `gemini-2.5-flash` (fast/cheap) or `gemini-2.5-pro` (stronger).
- **Alibaba Cloud Model Studio (DashScope)** — `qwen3-coder-plus`.
- **OpenRouter** — `qwen/qwen3-coder` and many others.

Cloud models send your code and prompts to that provider and use its quota/billing, unlike local Ollama which stays on your machine. Set **Max response tokens** in Settings to bound cost.

## 2. Run the app

You need [Node.js 20+](https://nodejs.org) on Windows.

```powershell
git clone https://github.com/MrRobotto512/Qwen-Workspace.git
cd Qwen-Workspace
npm install
npm start
```

In the app:

1. Click **⚙** in the top-right.
2. Pick your provider, click **Fetch models**, choose a Qwen model and click **Save**.
3. Open your project folder.

The dot next to the model name turns green when the app can reach the model server.

## 3. Build a Windows installer

```powershell
npm run dist        # installer, portable .exe and zip in dist/
```

GitHub Actions also builds the app on every push to `main`; the builds are under **Actions → Build Windows app → Artifacts**. When you publish a release on GitHub, the same workflow attaches the installer, the portable .exe and the zip to it.

## Updates

Publishing a GitHub release is all it takes. The **Build Windows app** workflow:
1. Sets the app version from the release tag (`0.3.0` or `v0.3.0` both work).
2. Builds the app.
3. Attaches the installer, portable .exe, zip and the update feed (`latest.yml`) to the release.

Installed copies pick it up within six hours, or right away through **Settings → Check for updates**.

## Tips

- Switch between **Agent** and **Chat** below the message box. Agent mode needs a model that supports tool calling (Qwen2.5-Coder, Qwen3 and Qwen3-Coder all do). In Chat mode, Qwen labels full-file code blocks with their path, so **Apply** still works.
- Turn **Follow Qwen** on or off in the status bar.
- Manage always-allowed commands in **Settings → Agent**.
- Right-click a file in the explorer and choose **Add to chat**, or press `Ctrl+Shift+A` to attach any file.
- Keyboard shortcuts:
  - `Ctrl+N` new conversation
  - `Ctrl+Shift+H` history
  - `Ctrl+O` open a folder
  - `Ctrl+P` go to file
  - `Ctrl+Shift+F` search
  - `Ctrl+B` toggle the side panel
  - `Ctrl+S` save
  - `Ctrl+W` close the tab
  - `` Ctrl+` `` toggle the terminal
  - `Ctrl+L` focus the chat
  - `F12` open DevTools
- Qwen can only touch files inside the open project folder.
- Settings are stored in `%APPDATA%\qwen-workspace\settings.json`, and conversations in `%APPDATA%\qwen-workspace\conversations\`.

## How Qwen's context is assembled

Each request is built in layers, from least to most likely to change, so Ollama can reuse its prompt cache:

1. **System prompt**, fixed for the whole conversation. It holds Qwen's role and rules, the OS and project folder, `QWEN.md`, the list of skills and the names of the deferred tools.
2. **History**, stored as it happened. Older turns may be replaced by a `<conversation-summary>`.
3. **A `<system-reminder>` on the newest message only.** It holds the open file and selection, the plan, and the files changed so far. It's rebuilt for every request and never stored, so earlier turns stay byte-identical.

Long tool results come back in pages (`read_file` returns 400 lines at a time with a pointer to the next page), instead of whole files.

### Skill file format

```markdown
---
name: build-cmake
description: How to configure and build this project with CMake on Windows
---
Steps, conventions and gotchas go here. Other files in the folder can be loaded by name.
```

## Project layout

```
src/
  main.js            Electron main process: window, file system, commands, streaming model API
  preload.js         Safe bridge exposed to the UI as window.api
  renderer/
    index.html       Layout
    icons.js         Line icons and file-type badges
    styles.css       Dark theme
    models.js        Qwen model catalog and hardware fit estimates
    app.js           Editor, explorer, chat, agent loop, diff view, terminal, updates, model picker
  hardware.js        GPU / VRAM / RAM / CPU detection
  updater.js         Update checks against GitHub Releases (electron-updater for the installer)
```
