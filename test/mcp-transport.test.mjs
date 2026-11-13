import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRpcInput } from '../src/rpc-input.mjs';

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const ping = { jsonrpc: '2.0', id: 7, method: 'ping' };
const run = (input) => spawnSync(process.execPath, [server], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });

test('stdio survives malformed JSON and rejects invalid requests before responding to ping', () => {
  const result = run('{broken\n[]\n{"jsonrpc":"2.0","id":3,"method":9}\n' + JSON.stringify(ping) + '\n');
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].error.code, -32600);
  assert.equal(messages[2].error.code, -32600);
  assert.deepEqual(messages[3], { jsonrpc: '2.0', id: 7, result: {} });
});

test('notifications have no responses, including known methods with no request id', () => {
  const result = run(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }) + '\n' + JSON.stringify(ping) + '\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), [{ jsonrpc: '2.0', id: 7, result: {} }]);
});

test('MCP validates tool argument types and negotiates a supported protocol version', () => {
  const invalid = [{ fullScan: 'false' }, { projectMode: 'unrecognized' }, { testTimeoutMs: 0 },
    { allowInconclusive: 'true' }, null, []];
  const messages = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
    ...invalid.map((args, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: 'flow_verify', arguments: args } }))];
  const result = run(messages.map(JSON.stringify).join('\n') + '\n');
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].result.protocolVersion, '2025-11-25');
  assert.equal(responses.length, messages.length);
  for (const response of responses.slice(1)) assert.equal(response.result.isError, true);
});

test('framing handles every byte boundary and Unicode, and switches per message', () => {
  const messages = [], frames = [], errors = [];
  const input = createRpcInput({ onMessage: (message) => messages.push(message), onParseError: () => errors.push('parse'), onFraming: (header) => frames.push(header) });
  const first = { jsonrpc: '2.0', id: '中文', method: 'ping' };
  const body = JSON.stringify(first);
  const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}{oops\n${JSON.stringify(ping)}\r\n`);
  for (const byte of bytes) input.write(Buffer.from([byte]));
  input.end();
  assert.deepEqual(messages, [first, ping]);
  assert.deepEqual(frames, [true, false, false]);
  assert.deepEqual(errors, ['parse']);
});

test('real stdio process answers a Content-Length frame with a byte-correct response', () => {
  const request = JSON.stringify({ ...ping, id: '中文' });
  const result = run(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
  assert.equal(result.status, 0, result.stderr);
  const boundary = result.stdout.indexOf('\r\n\r\n');
  const body = result.stdout.slice(boundary + 4);
  assert.equal(Number(result.stdout.slice(0, boundary).split(':')[1]), Buffer.byteLength(body));
  assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: '中文', result: {} });
});

test('framing bounds incomplete input and rejects conflicting lengths', () => {
  const input = () => createRpcInput({ onMessage() {}, onParseError() {}, onFraming() {}, maxBytes: 40 });
  assert.throws(() => input().write(Buffer.from('x'.repeat(41))), /size limit/);
  assert.throws(() => input().write(Buffer.from('Content-Length: 41\r\n\r\n')), /Content-Length/);
  assert.throws(() => input().write(Buffer.from('Content-Length: 4\r\nContent-Length: 5\r\n\r\nnull')), /Content-Length/);
  assert.throws(() => input().write(Buffer.from('Content-Length: NaN\r\n\r\n')), /Content-Length/);
  assert.throws(() => input().write(Buffer.from('Content-Length:' + ' '.repeat(8192))), /header/);
  let errors = 0;
  const partial = createRpcInput({ onMessage() {}, onParseError() { errors++; }, onFraming() {} });
  partial.write(Buffer.from('{"jsonrpc":'));
  partial.end();
  assert.equal(errors, 1);
});
