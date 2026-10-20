// Detects the machine's memory, CPU and GPUs so the app can suggest models that will run well.
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function vendorOf(name) {
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/i.test(name)) return 'nvidia';
  if (/amd|radeon|ati\b/i.test(name)) return 'amd';
  if (/intel|iris|uhd|arc\b/i.test(name)) return 'intel';
  if (/apple/i.test(name)) return 'apple';
  return 'other';
}

// REG_BINARY values arrive from PowerShell as byte arrays (little-endian).
function bytesValue(v) {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.reduce((sum, b, i) => sum + b * 2 ** (8 * i), 0);
  return 0;
}

// Dedicated VRAM on Windows. WMI's AdapterRAM caps at 4 GB, so read the 64-bit value the
// display driver writes to the registry instead.
const WINDOWS_GPU_SCRIPT = [
  "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
  'Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  "  if ($p.DriverDesc) { [PSCustomObject]@{ name = $p.DriverDesc; qw = $p.'HardwareInformation.qwMemorySize'; legacy = $p.'HardwareInformation.MemorySize' } }",
  '} | ConvertTo-Json -Compress'
].join('\n');

async function detectGpus(ramGB) {
  const gpus = [];
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (smi) {
    for (const line of smi.trim().split(/\r?\n/)) {
      const [name, mib] = line.split(',').map((s) => s.trim());
      if (name && Number(mib)) gpus.push({ name, vramGB: Number(mib) / 1024, vendor: 'nvidia', source: 'nvidia-smi' });
    }
  }
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_GPU_SCRIPT], 12000);
    if (out && out.trim()) {
      let list = [];
      try {
        list = JSON.parse(out);
      } catch {
        /* unexpected output */
      }
      for (const g of Array.isArray(list) ? list : [list]) {
        if (!g?.name || gpus.some((x) => x.name === g.name)) continue;
        const bytes = bytesValue(g.qw) || bytesValue(g.legacy);
        gpus.push({ name: g.name, vramGB: bytes / 1024 ** 3, vendor: vendorOf(g.name), source: 'registry' });
      }
    }
  } else if (process.platform === 'darwin' && process.arch === 'arm64') {
    // Apple Silicon shares system memory with the GPU; macOS lets the GPU use roughly 70% of it.
    gpus.push({ name: 'Apple Silicon GPU', vramGB: ramGB * 0.7, vendor: 'apple', unified: true, source: 'unified memory' });
  } else if (process.platform === 'linux' && !gpus.length) {
    const rocm = await run('rocm-smi', ['--showmeminfo', 'vram', '--json']);
    if (rocm) {
      try {
        for (const [card, info] of Object.entries(JSON.parse(rocm))) {
          const total = Number(Object.entries(info).find(([k]) => /total memory/i.test(k))?.[1]);
          if (total) gpus.push({ name: `AMD GPU (${card})`, vramGB: total / 1024 ** 3, vendor: 'amd', source: 'rocm-smi' });
        }
      } catch {
        /* ignore */
      }
    }
  }
  return gpus;
}

let cached = null;

async function detectSpecs(force) {
  if (cached && !force) return cached;
  const ramGB = os.totalmem() / 1024 ** 3;
  const cpus = os.cpus();
  const gpus = await detectGpus(ramGB);
  // Ollama runs on NVIDIA, AMD and Apple GPUs. Small integrated GPUs don't help.
  const usable = gpus.filter((g) => ['nvidia', 'amd', 'apple'].includes(g.vendor) && g.vramGB >= 2).sort((a, b) => b.vramGB - a.vramGB);
  cached = {
    platform: process.platform,
    arch: process.arch,
    ramGB,
    freeRamGB: os.freemem() / 1024 ** 3,
    cpu: cpus[0]?.model?.trim() || 'Unknown CPU',
    threads: cpus.length,
    gpus,
    gpu: usable[0] || null
  };
  return cached;
}

module.exports = { detectSpecs };
