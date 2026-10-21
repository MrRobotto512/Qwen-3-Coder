// Checks GitHub Releases for a newer version. The NSIS-installed app downloads and installs
// updates itself (electron-updater); the portable .exe and the zip open the release page instead.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = { owner: 'MrRobotto512', repo: 'Qwen-Workspace' };
const RELEASES_URL = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;

let lastCheck = null;

function installKind() {
  if (!app.isPackaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (process.platform === 'win32') {
    try {
      const dir = path.dirname(process.execPath);
      if (fs.readdirSync(dir).some((f) => /^Uninstall .*\.exe$/i.test(f))) return 'installer';
    } catch {
      /* fall through */
    }
  }
  return 'zip';
}

// Pulls X.Y.Z out of tags like "0.3.0", "v0.3.0", "v.0.3.0" or "release-0.3.0".
function parseVersion(v) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0];
}

function versionString(v) {
  return parseVersion(v).join('.');
}

function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  const current = app.getVersion();
  const kind = installKind();
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Qwen-Workspace/${current}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (res.status === 404) return (lastCheck = { current, kind, available: false, latest: null, url: RELEASES_URL });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  const rel = await res.json();
  const latest = versionString(rel.tag_name || rel.name);
  const hasUpdateFeed = (rel.assets || []).some((a) => a.name === 'latest.yml');
  lastCheck = {
    current,
    kind,
    latest,
    available: isNewer(latest, current),
    notes: rel.body || '',
    url: rel.html_url || RELEASES_URL,
    publishedAt: rel.published_at,
    canInstall: kind === 'installer' && hasUpdateFeed
  };
  return lastCheck;
}

let updater = null;

// Downloads the update in the background; resolves when it is ready to install.
async function downloadUpdate(onProgress) {
  if (!lastCheck?.canInstall) {
    await shell.openExternal(lastCheck?.url || RELEASES_URL);
    return { opened: true };
  }
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    // Point at the releases directly so the updater doesn't depend on a generated app-update.yml.
    updater.setFeedURL({ provider: 'github', owner: REPO.owner, repo: REPO.repo });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.logger = null;
  }
  updater.removeAllListeners('download-progress');
  updater.on('download-progress', (p) => onProgress({ percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
  const result = await updater.checkForUpdates();
  if (!result?.updateInfo || !isNewer(result.updateInfo.version, app.getVersion())) {
    throw new Error('The update feed does not list a newer version yet. Try again in a few minutes.');
  }
  await updater.downloadUpdate();
  return { ready: true, version: result.updateInfo.version };
}

function installUpdate() {
  if (!updater) return false;
  // Defer so the IPC reply goes out before the app starts shutting down.
  setImmediate(() => updater.quitAndInstall(false, true));
  return true;
}

module.exports = { checkForUpdate, downloadUpdate, installUpdate, installKind, isNewer, RELEASES_URL };
