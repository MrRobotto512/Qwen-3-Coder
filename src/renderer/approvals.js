'use strict';

// Command-approval rules, kept free of DOM/state so they can be unit-tested in Node.
// Loaded as a plain <script> in the renderer (globals) and required by test/approvals.test.js.

// Commands that always ask, in every approval mode. Includes anything that fetches from the
// network or launches another program, since those can run arbitrary code.
const DANGEROUS_COMMAND = /\b(rm\s+-[a-z]*[rf]|rmdir|rd\s+\/s|del\s|erase\s|format\s|mkfs|shutdown|reboot|reg\s+delete|remove-item|git\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D)|npm\s+publish|diskpart|bcdedit|takeown|icacls|curl|wget|invoke-webrequest|iwr|invoke-expression|iex|powershell|pwsh|cmd\s+\/c|start\s|msiexec|certutil|bitsadmin|scp|ssh)\b/i;

// Shell metacharacters that chain commands, redirect output, spawn subshells or expand
// variables. A command using any of these is split into segments and every segment must be
// allow-listed, so an always-allowed prefix can't smuggle a second command after `&&`.
const SHELL_SPLIT = /&&|\|\||;|\||&|\n/;
const SHELL_META = /[>`]|\$\(|%[^%\s]+%/;

function commandSegments(cmd) {
  return String(cmd).split(SHELL_SPLIT).map((x) => x.trim()).filter(Boolean);
}

// Pure allow-list check: every segment must match an allowed prefix, and the command must not
// use redirection, subshells or variable expansion.
function isCommandAllowed(cmd, allowed) {
  const list = (allowed || []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const whole = String(cmd).trim().toLowerCase();
  const segMatches = (seg) =>
    list.some((pre) => (pre.endsWith('__') ? seg.startsWith(pre) : seg === pre || seg.startsWith(pre + ' ')));
  // MCP tool calls (mcp__server__tool) carry no shell syntax; match the whole string.
  if (whole.startsWith('mcp__')) return segMatches(whole);
  if (SHELL_META.test(whole)) return false;
  const segs = commandSegments(whole);
  return segs.length > 0 && segs.every(segMatches);
}

// Pure approval decision for a command, so it can be unit-tested without the UI.
function commandNeedsApproval(mode, command, allowed) {
  if (DANGEROUS_COMMAND.test(command)) return true;
  if (mode === 'auto') return false;
  return mode === 'ask' || !isCommandAllowed(command, allowed);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DANGEROUS_COMMAND, SHELL_SPLIT, SHELL_META, commandSegments, isCommandAllowed, commandNeedsApproval };
}
