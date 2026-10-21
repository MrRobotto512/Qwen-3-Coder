// Where the headless agent keeps its state and how it finds its model profiles.
//
// Home folder (jobs, worktrees, config): $QWEN_AGENT_HOME, else ~/.qwen-agent.
// Config file: <home>/config.json
//   {
//     "profiles": [
//       { "name": "hosted", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY",
//         "model": "qwen/qwen3-coder", "contextLength": 131072 },
//       { "name": "local", "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:14b", "contextLength": 32768 }
//     ],
//     "maxSteps": 60,
//     "webResearch": true,
//     "searchProvider": "duckduckgo"
//   }
// Profiles are tried in order; later ones are the fallback. An API key can be given inline
// ("apiKey") but "apiKeyEnv" (the name of an environment variable) keeps it out of the file.
// With no config file, the desktop app's own settings.json is used as a single profile.

const fs = require('fs');
const os = require('os');
const path = require('path');

function agentHome() {
  return process.env.QWEN_AGENT_HOME || path.join(os.homedir(), '.qwen-agent');
}

function desktopSettingsPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'qwen-workspace', 'settings.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'qwen-workspace', 'settings.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'qwen-workspace', 'settings.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolveProfile(p, i) {
  const apiKey = p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] || '' : '');
  if (!p.baseUrl) throw new Error(`Profile ${i + 1} has no baseUrl.`);
  if (!p.model) throw new Error(`Profile ${i + 1} (${p.name || p.baseUrl}) has no model.`);
  return {
    name: p.name || `profile${i + 1}`,
    baseUrl: p.baseUrl,
    apiKey,
    apiKeyEnv: p.apiKeyEnv,
    model: p.model,
    temperature: p.temperature ?? 0.2,
    contextLength: Number(p.contextLength) || 32768,
    kind: p.kind // 'openai' | 'ollama' | undefined = auto-detect
  };
}

function loadConfig({ file, overrides = {} } = {}) {
  const home = agentHome();
  const cfgFile = file || path.join(home, 'config.json');
  let cfg = readJson(cfgFile);
  let source = cfgFile;
  if (!cfg) {
    const app = readJson(desktopSettingsPath());
    if (app?.baseUrl && app?.model) {
      cfg = { profiles: [{ name: 'app-settings', baseUrl: app.baseUrl, apiKey: app.apiKey, model: app.model, temperature: app.temperature, contextLength: app.contextLength }], maxSteps: app.maxSteps, webResearch: app.webResearch, searchProvider: app.searchProvider, searchApiKey: app.searchApiKey, searxngUrl: app.searxngUrl };
      source = desktopSettingsPath();
    }
  }
  if (!cfg) {
    throw new Error(`No model configured. Run "qwen-agent init" to create ${cfgFile}, or set up the desktop app's model once so its settings can be reused.`);
  }
  const profiles = (cfg.profiles || []).map(resolveProfile);
  if (overrides.model) profiles.forEach((p, i) => i === 0 && (p.model = overrides.model));
  if (!profiles.length) throw new Error(`${source} has no profiles.`);
  return {
    home,
    source,
    profiles,
    settings: {
      webResearch: overrides.webResearch ?? cfg.webResearch ?? true,
      searchProvider: cfg.searchProvider,
      searchApiKey: cfg.searchApiKey,
      searxngUrl: cfg.searxngUrl,
      allowPrivateFetch: false
    },
    maxSteps: cfg.maxSteps || 60,
    commandTimeoutMs: cfg.commandTimeoutMs || 120_000,
    modelRetries: cfg.modelRetries,
    modelBackoffMs: cfg.modelBackoffMs
  };
}

const SAMPLE_CONFIG = {
  profiles: [
    { name: 'hosted', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'qwen/qwen3-coder', contextLength: 131072, temperature: 0.2 },
    { name: 'local', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:14b', contextLength: 32768, temperature: 0.2 }
  ],
  maxSteps: 60,
  webResearch: true
};

function writeSampleConfig(file = path.join(agentHome(), 'config.json')) {
  if (fs.existsSync(file)) return { file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n');
  return { file, created: true };
}

module.exports = { agentHome, loadConfig, writeSampleConfig, desktopSettingsPath };
