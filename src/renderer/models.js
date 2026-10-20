'use strict';

// Qwen models available through Ollama, with the download size of the default 4-bit build and
// the approximate memory each token of context costs (KV cache, fp16). Rank orders them by how
// well they work as a coding agent.
const MODEL_CATALOG = [
  { id: 'qwen3-coder:30b', name: 'Qwen3-Coder 30B', sizeGB: 19, kvKB: 96, moe: true, rank: 10, agent: 'Excellent', note: 'Best local coding agent. A mixture-of-experts model with only 3B parameters active per token, so it stays usable even when part of it runs on the CPU.' },
  { id: 'qwen2.5-coder:32b', name: 'Qwen2.5-Coder 32B', sizeGB: 20, kvKB: 256, rank: 9, agent: 'Very good', note: 'Strong coder, but every token uses all 32B parameters, so it needs a big GPU to be quick.' },
  { id: 'qwen3:32b', name: 'Qwen3 32B', sizeGB: 20, kvKB: 256, rank: 8, agent: 'Very good', note: 'General model with strong reasoning; good at planning multi-step changes.' },
  { id: 'qwen3:30b', name: 'Qwen3 30B', sizeGB: 19, kvKB: 96, moe: true, rank: 7.5, agent: 'Very good', note: 'General mixture-of-experts model; fast for its size, like Qwen3-Coder 30B.' },
  { id: 'qwen2.5-coder:14b', name: 'Qwen2.5-Coder 14B', sizeGB: 9, kvKB: 192, rank: 6.5, agent: 'Good', note: 'Good balance of quality and speed on 12–16 GB GPUs.' },
  { id: 'qwen3:14b', name: 'Qwen3 14B', sizeGB: 9.3, kvKB: 160, rank: 6, agent: 'Good', note: 'General model; good tool use for its size.' },
  { id: 'qwen2.5-coder:7b', name: 'Qwen2.5-Coder 7B', sizeGB: 4.7, kvKB: 56, rank: 4.5, agent: 'Fair', note: 'Fine for explanations and small edits; can lose track on long agent tasks.' },
  { id: 'qwen3:8b', name: 'Qwen3 8B', sizeGB: 5.2, kvKB: 144, rank: 4, agent: 'Fair', note: 'General model; decent tool use for small tasks.' },
  { id: 'qwen3:4b', name: 'Qwen3 4B', sizeGB: 2.5, kvKB: 144, rank: 2, agent: 'Basic', note: 'For low-memory machines. Use Chat mode for anything complex.' },
  { id: 'qwen2.5-coder:3b', name: 'Qwen2.5-Coder 3B', sizeGB: 1.9, kvKB: 36, rank: 1, agent: 'Weak', note: 'Autocomplete-sized; not reliable in Agent mode.' },
  { id: 'qwen2.5-coder:1.5b', name: 'Qwen2.5-Coder 1.5B', sizeGB: 1, kvKB: 28, rank: 0, agent: 'Weak', note: 'Very small; quick answers only.' }
];

const CONTEXT_STEPS = [32768, 24576, 16384, 12288, 8192];
const RUNTIME_OVERHEAD_GB = 0.8;

function memoryNeededGB(model, ctx) {
  return model.sizeGB + (model.kvKB * ctx) / 1024 ** 2 + RUNTIME_OVERHEAD_GB;
}

// How a model would run on this machine at a given context size.
function fitAt(model, specs, ctx) {
  const vram = specs.gpu ? specs.gpu.vramGB : 0;
  const need = memoryNeededGB(model, ctx);
  if (vram && need <= vram * 0.95) return 'gpu';
  // Whatever doesn't fit on the GPU runs from system RAM; leave room for Windows and other apps.
  const spare = specs.gpu?.unified ? 0 : Math.max(0, specs.ramGB * 0.75 - 3);
  if (need > vram + spare) return 'none';
  if (model.moe) return 'mixed';
  return vram && model.sizeGB <= vram * 1.25 ? 'mixed' : 'cpu';
}

const FIT_INFO = {
  gpu: { label: 'Fast · fits in GPU memory', short: 'Fast', level: 3 },
  mixed: { label: 'Usable · partly on CPU', short: 'Usable', level: 2 },
  cpu: { label: 'Slow · mostly on CPU', short: 'Slow', level: 1 },
  none: { label: 'Too large for this PC', short: 'Too large', level: 0 }
};

function evaluateModel(model, specs) {
  // Largest context that keeps the model fully on the GPU, if any.
  for (const ctx of CONTEXT_STEPS) {
    if (fitAt(model, specs, ctx) === 'gpu') return { ...model, fit: 'gpu', ctx, needGB: memoryNeededGB(model, ctx) };
  }
  const ctx = 16384;
  const fit = fitAt(model, specs, ctx);
  if (fit !== 'none') return { ...model, fit, ctx, needGB: memoryNeededGB(model, ctx) };
  const small = fitAt(model, specs, 8192);
  return { ...model, fit: small, ctx: 8192, needGB: memoryNeededGB(model, 8192) };
}

// Returns every catalog model rated for this machine, plus the two worth highlighting:
// the best one that runs fully on the GPU with a useful context, and the most capable one
// that still runs at a usable speed.
function recommendModels(specs) {
  const models = MODEL_CATALOG.map((m) => evaluateModel(m, specs));
  const byRank = [...models].sort((a, b) => b.rank - a.rank);
  const fast = byRank.find((m) => m.fit === 'gpu' && m.ctx >= 16384) || byRank.find((m) => m.fit === 'gpu');
  const capable = byRank.find((m) => m.fit === 'gpu' || m.fit === 'mixed');
  const fallback = byRank.find((m) => m.fit === 'cpu' && m.rank >= 2) || byRank.find((m) => m.fit !== 'none');
  const recommended = fast || capable || fallback || null;
  const stronger = capable && recommended && capable.rank > recommended.rank ? capable : null;
  return { models, recommended, stronger };
}

function describeSpecs(specs) {
  const parts = [];
  if (specs.gpu) parts.push(`${specs.gpu.name} · ${formatGB(specs.gpu.vramGB)}${specs.gpu.unified ? ' usable (shared)' : ' VRAM'}`);
  else parts.push(specs.gpus.length ? `${specs.gpus.map((g) => g.name).join(', ')} (not used by Ollama)` : 'No supported GPU found');
  parts.push(`${formatGB(specs.ramGB)} RAM`);
  parts.push(`${specs.threads} CPU threads`);
  return parts;
}

function formatGB(gb) {
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
}

function formatContext(ctx) {
  return `${Math.round(ctx / 1024)}K`;
}
