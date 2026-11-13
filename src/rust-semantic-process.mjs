// Isolated LSP client. The parent remains synchronous; this process owns and
// bounds the analyzer's entire process tree, including Cargo build scripts.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRpcInput } from './rpc-input.mjs';

const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const child = spawn(config.executable || 'rust-analyzer', [], {
  cwd: config.root, windowsHide: true, detached: process.platform !== 'win32',
  stdio: ['pipe', 'pipe', 'pipe']
});
let seq = 0, stderr = '', finished = false, version = null;
const pending = new Map(), statuses = [], diagnostics = new Map();
let readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
function send(value) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
}
function stop() {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { child.kill('SIGKILL'); }
}
function finish(result) {
  if (finished) return;
  finished = true; clearTimeout(timer); stop();
  process.stdout.write(JSON.stringify({ version, configuration: config.settings, statuses,
    diagnostics: [...diagnostics.values()].flat(), stderr, ...result }), () => process.exit(0));
}
const timer = setTimeout(() => finish({ outcome: 'TIMED_OUT', reason: 'Rust semantic analysis exceeded its deadline' }), config.timeoutMs);
const input = createRpcInput({ onFraming() {}, onParseError() { finish({ outcome: 'EXECUTION_ERROR', reason: 'Invalid analyzer JSON' }); }, onMessage(message) {
  if (message.method && message.id !== undefined) {
    if (message.method === 'workspace/configuration') send({ id: message.id, result: message.params.items.map(() => config.settings) });
    else send({ id: message.id, result: null });
  } else if (message.method === 'experimental/serverStatus') {
    statuses.push(message.params);
    if (statuses.length > 30) statuses.shift();
    if (message.params.quiescent) readyResolve();
  } else if (message.method === 'textDocument/publishDiagnostics') {
    diagnostics.set(message.params.uri, message.params.diagnostics.filter(d => d.severity === 1).map(d => ({ uri: message.params.uri, message: d.message, range: d.range })));
  } else if (pending.has(message.id)) {
    const task = pending.get(message.id); pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  }
} });
child.stdout.on('data', chunk => { try { input.write(chunk); } catch (error) { finish({ outcome: 'EXECUTION_ERROR', reason: error.message }); } });
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
child.stdin.on('error', () => {});
child.on('error', error => finish({ outcome: 'EXECUTION_ERROR', reason: error.message }));
child.on('close', code => { if (!finished) finish({ outcome: 'EXECUTION_ERROR', reason: `Analyzer exited (${code})` }); });
try {
  const rootUri = pathToFileURL(config.root).href;
  const init = await request('initialize', { processId: process.pid, rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'flow-guard' }],
    capabilities: { experimental: { serverStatusNotification: true }, workspace: { configuration: true },
      textDocument: { callHierarchy: { dynamicRegistration: false } } }, initializationOptions: config.settings });
  version = init.serverInfo || null;
  send({ method: 'initialized', params: {} });
  await ready;
  const results = [];
  for (const query of config.queries) {
    const items = await request('textDocument/prepareCallHierarchy', { textDocument: { uri: query.uri }, position: query.position });
    const calls = [];
    for (const item of items || []) calls.push(...(await request('callHierarchy/outgoingCalls', { item }) || []));
    for (const call of calls.filter(call => call.to.uri.toLowerCase().startsWith(`${rootUri.toLowerCase()}/`))) {
      call.implementations = await request('textDocument/implementation', {
        textDocument: { uri: call.to.uri }, position: call.to.selectionRange.start
      }) || [];
    }
    results.push({ id: query.id, items, calls });
  }
  const expansions = [];
  for (const query of config.macros || []) {
    expansions.push({ ...query, expansion: await request('rust-analyzer/expandMacro', {
      textDocument: { uri: query.uri }, position: query.position
    }) });
  }
  finish({ outcome: 'COMPLETED', results, expansions });
} catch (error) { finish({ outcome: 'EXECUTION_ERROR', reason: error.message }); }
