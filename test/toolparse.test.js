'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { textToolCallStart, extractTextToolCalls } = require('../src/renderer/toolparse.js');
const NAMES = ['list_files', 'read_file', 'search_code', 'edit_file', 'write_file', 'run_command', 'mcp__rea__analyze_binary'];

test('plain prose has no tool call', () => {
  assert.equal(textToolCallStart('Just explaining the code here.', NAMES), -1);
  assert.deepEqual(extractTextToolCalls('hello world', NAMES).calls, []);
});

test('bare JSON tool call in a ```json fence', () => {
  const text = 'Let me look.\n```json\n{"name": "list_files", "arguments": {"path": "."}}\n```';
  const r = extractTextToolCalls(text, NAMES);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, 'list_files');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: '.' });
  assert.equal(r.cleaned, 'Let me look.');
});

test('ordinary JSON that is not a tool name is left alone', () => {
  const text = 'Here is config:\n```json\n{"name": "my-app", "version": "1.0.0"}\n```';
  assert.deepEqual(extractTextToolCalls(text, NAMES).calls, []);
});

test('Qwen3-Coder XML style with missing closing tags', () => {
  const text = '<function=edit_file>\n<parameter=path>\nsrc/a.py\n</parameter>\n<parameter=old_text>\nx = 1\n</parameter>\n<parameter=new_text>\nx = 2';
  const r = extractTextToolCalls(text, NAMES);
  assert.equal(r.calls[0].function.name, 'edit_file');
  const args = JSON.parse(r.calls[0].function.arguments);
  assert.equal(args.path, 'src/a.py');
  assert.equal(args.old_text, 'x = 1');
  assert.equal(args.new_text, 'x = 2');
});

test('<tool_call> JSON tag form', () => {
  const text = 'ok<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>';
  const r = extractTextToolCalls(text, NAMES);
  assert.equal(r.calls[0].function.name, 'read_file');
});

test('numeric and boolean XML params are coerced', () => {
  const text = '<function=read_file><parameter=path>a.py</parameter><parameter=start_line>5</parameter></function>';
  const args = JSON.parse(extractTextToolCalls(text, NAMES).calls[0].function.arguments);
  assert.strictEqual(args.start_line, 5);
});

test('MCP tool names are recognized', () => {
  const text = '{"name": "mcp__rea__analyze_binary", "arguments": {"path": "x"}}';
  assert.equal(extractTextToolCalls(text, NAMES).calls[0].function.name, 'mcp__rea__analyze_binary');
});

test('announcesAction: announce-then-stop replies are caught', () => {
  const { announcesAction } = require('../src/renderer/toolparse.js');
  // Trailing colon before an action that never came (the screenshot cases).
  assert.equal(announcesAction("Let's begin by asking the user which DVD ripping tool they prefer:"), true);
  assert.equal(announcesAction("Let's start by verifying Docker and installing Visual Studio Build Tools:"), true);
  // Announce phrasing without a colon.
  assert.equal(announcesAction("I'll now fetch the PCSX2 documentation."), true);
  assert.equal(announcesAction('Next, we will install the DVD ripping tool.'), true);
  assert.equal(announcesAction("Sure, let's ask the user which tool they prefer"), true);
});

test('announcesAction: real final answers are left alone', () => {
  const { announcesAction } = require('../src/renderer/toolparse.js');
  assert.equal(announcesAction('Done. I created rip-ps2.ps1 and added a QWEN.md note about the toolchain.'), false);
  assert.equal(announcesAction('The build failed because dlltool.exe is missing; install MinGW-w64 and retry.'), false);
  assert.equal(announcesAction('All tests pass and the feature is complete.'), false);
  assert.equal(announcesAction(''), false);
});

test('looksLikeInstructions: step-by-step how-tos are caught', () => {
  const { looksLikeInstructions } = require('../src/renderer/toolparse.js');
  const tutorial = ['Here is how to create the application:', '', '### Step 1: Install Tools', '1. Install Node.js.', '2. Install Rust.', '', '### Step 6: Test and Debug', '1. Build and run the application.', '2. Test the DVD extraction and game launch.', '3. Debug any issues that arise.', '', '### Step 7: Package and Distribute', '1. Package the application for distribution.', '2. Ensure it is user-friendly and easy to install.', '', 'This is a basic outline of the steps required to create the application.'].join('\n');
  assert.equal(looksLikeInstructions(tutorial), 'steps');
  const numbered = 'To set this up you will need to do the following, roughly in order, and each item matters:\n1. Download the SDK from the site.\n2. Unzip it to C:\\sdk and add it to PATH for your user account.\n3. Run the installer with the default options selected.\n4. Reboot the machine before the first build attempt.\n5. Verify with sdk --version from a fresh terminal.';
  assert.equal(looksLikeInstructions(numbered), 'list');
});

test('looksLikeInstructions: normal answers are left alone', () => {
  const { looksLikeInstructions } = require('../src/renderer/toolparse.js');
  assert.equal(looksLikeInstructions('Short answer.'), false);
  assert.equal(looksLikeInstructions('Done. I created rip.ps1, tested it against the drive, and documented the toolchain in QWEN.md. The script watches for a disc and launches PCSX2 when the ISO is ready, which covers everything you asked for.'), false);
  const options = 'You have two options here: either we rip with a raw device read, which needs no extra software but is slower, or we install ImgBurn, which is faster and more robust for scratched discs. Tell me which you prefer and I will set it up.';
  assert.equal(looksLikeInstructions(options), false);
});
