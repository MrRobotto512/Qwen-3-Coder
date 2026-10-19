# Qwen Workspace

A desktop coding workspace for Windows, powered by **Qwen**. It has a file explorer, a VS Code–style editor (Monaco), a terminal, and a Qwen chat panel that can read, search and edit your project. Every edit and command needs your approval.

## Download

Grab the latest build from the [Releases page](https://github.com/MrRobotto512/Qwen-3-Coder/releases): the installer, a portable `.exe`, or a zip. The builds aren't code-signed, so Windows SmartScreen may warn you the first time. Click **More info → Run anyway**.

## Features

- **Explorer:** open any project folder; create, delete and reveal files.
- **Editor:** Monaco with tabs, syntax highlighting and `Ctrl+S` to save.
- **Qwen chat:**
  - Streams responses and shows Qwen's thinking in a collapsible block.
  - Attaches the open file (and your selection) as context.
  - Every code block gets **Copy**, **Insert at cursor** and **Apply to file** buttons. Apply shows a diff first.
- **Agent mode:** Qwen can use these tools:
  - `list_files`
  - `read_file`
  - `search_code`
  - `edit_file`
  - `write_file`
  - `run_command`

  Edits show an inline diff (plus a full side-by-side diff view) and wait for **Approve / Reject**.
- **Terminal panel:** run commands in your project folder (`cmd.exe` on Windows).
- **Works with any OpenAI-compatible server:** presets for Ollama, LM Studio, Alibaba Cloud (DashScope) and OpenRouter.

## 1. Get a Qwen model running

### Option A: Ollama (free, local, private)

1. Install Ollama from https://ollama.com/download.
2. Pull a Qwen coding model that fits your GPU:

   ```powershell
   ollama pull qwen2.5-coder:7b     # ~5 GB, good for 8 GB+ VRAM
   ollama pull qwen2.5-coder:14b    # better, needs ~12 GB VRAM
   ollama pull qwen3-coder:30b      # best local option if you have the memory
   ```

3. That's it. The app talks to Ollama's own API and sets the context window itself (32,768 tokens by default; change it under **⚙ → Context window**). Use a lower value if Ollama runs out of GPU memory. The status line under the chat shows how much of the window is in use.

### Option B: LM Studio

Download a Qwen2.5-Coder or Qwen3-Coder model, then start the local server from the **Developer** tab (port 1234).

### Option C: Cloud API

Use **Alibaba Cloud Model Studio (DashScope)** (model `qwen3-coder-plus`) or **OpenRouter** (`qwen/qwen3-coder`). Paste your API key in Settings.

## 2. Run the app

You need [Node.js 20+](https://nodejs.org) on Windows.

```powershell
git clone https://github.com/MrRobotto512/Qwen-3-Coder.git
cd Qwen-3-Coder
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

## Tips

- **Agent mode** (checkbox in the chat header) needs a model that supports tool calling. Qwen2.5-Coder, Qwen3 and Qwen3-Coder all do. If a model errors on tools, untick Agent and use plain chat. In plain chat, Qwen labels full-file code blocks with their path, so **Apply to file** still works.
- Right-click a file in the explorer and choose **Add to chat** to attach it.
- Keyboard shortcuts:
  - `Ctrl+O` open a folder
  - `Ctrl+S` save
  - `Ctrl+W` close the tab
  - `` Ctrl+` `` toggle the terminal
  - `Ctrl+L` focus the chat
  - `F12` open DevTools
- Qwen can only touch files inside the open project folder.
- Settings are stored in `%APPDATA%\qwen-workspace\settings.json`.

## Project layout

```
src/
  main.js            Electron main process: window, file system, commands, streaming model API
  preload.js         Safe bridge exposed to the UI as window.api
  renderer/
    index.html       Layout
    styles.css       Dark theme
    app.js           Editor, explorer, chat, agent loop, diff view, terminal
```
