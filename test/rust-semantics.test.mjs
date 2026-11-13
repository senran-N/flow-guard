import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { scanWorkspaceParsedFiles } from '../src/graph-builder.mjs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mapRustSemanticCalls } from '../src/rust-semantics.mjs';
import { verifyWorkspaceFlow } from '../src/flow-verifier.mjs';

const root = path.resolve('semantic-map-fixture');
const uri = pathToFileURL(path.join(root, 'src/main.rs')).href;
const range = line => ({ start: { line, character: 3 }, end: { line, character: 7 } });
const symbol = (name, line, kind = 'function', parentContainerName = null) => ({
  id: `${name}:${line}`, name, startLine: line, endLine: line, kind, parentContainerName
});
const files = [{ file: 'src/main.rs', symbols: [symbol('main', 1), symbol('Worker', 2, 'struct'),
  symbol('execute', 3, 'method', 'Worker'), symbol('perform', 6, 'method', 'Worker')] }];
const target = (name, line) => ({ name, uri, selectionRange: range(line - 1) });
const report = calls => ({ outcome: 'COMPLETED', statuses: [{ health: 'ok' }],
  results: [{ id: 'main:1', calls }] });

test('compiler references map exact declarations and do not guess names', () => {
  const result = mapRustSemanticCalls(root, files, report([
    { to: target('execute', 3), fromRanges: [range(0)] },
    { to: target('execute', 9), fromRanges: [range(0)] },
    { to: { ...target('execute', 3), uri: pathToFileURL(path.join(root, '../dependency/lib.rs')).href }, fromRanges: [range(0)] }
  ]));
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].toId, 'execute:3');
  assert.equal(result.edges[0].resolution.confidence, 'HIGH');
  assert.equal(result.unmapped.length, 1);
});

test('trait implementation lookup creates candidates without runtime certainty', () => {
  const result = mapRustSemanticCalls(root, files, report([{ to: target('perform', 4),
    implementations: [{ uri, range: range(5) }], fromRanges: [range(0)] }]));
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].toId, 'perform:6');
  assert.equal(result.edges[0].resolution.confidence, 'MEDIUM');
  assert.equal(result.edges[0].resolution.mode, 'RUST_COMPILER_TRAIT_CANDIDATE');
});

test('failed or unhealthy semantic analysis cannot add edges', () => {
  const value = report([{ to: target('execute', 3), fromRanges: [range(0)] }]);
  for (const invalid of [{ ...value, outcome: 'TIMED_OUT' }, { ...value, statuses: [{ health: 'error' }] }]) {
    assert.deepEqual(mapRustSemanticCalls(root, files, invalid).edges, []);
  }
});

test('semantic analysis rejects historical checkout and implicit diff use', () => {
  assert.throws(() => verifyWorkspaceFlow(root, { rustSemantic: true }), /fullScan/);
  assert.throws(() => verifyWorkspaceFlow(root, { rustSemantic: true, fullScan: true, baseRef: 'HEAD' }), /baseRef/);
});

test('an analyzer deadline produces structured evidence and terminates the runner', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/rust-semantic-process.mjs', import.meta.url))], {
    input: JSON.stringify({ root: process.cwd(), timeoutMs: 1, settings: {}, executable: process.execPath, queries: [] }),
    encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'TIMED_OUT');
});

test('Tauri generated bundles are excluded from source analysis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-tauri-output-'));
  try {
    fs.mkdirSync(path.join(dir, 'build-tauri/assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build-tauri/assets/output.js'), 'function generated() {}');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export function source() {}');
    assert.deepEqual(scanWorkspaceParsedFiles(dir).files.map(file => file.file), ['app.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing analyzer is an execution error rather than a passing verification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-missing-analyzer-'));
  const oldPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname="missing_analyzer"\nversion="0.1.0"\n');
    fs.writeFileSync(path.join(dir, 'src/main.rs'), 'fn main() {}\n');
    process.env.PATH = '';
    const report = verifyWorkspaceFlow(dir, { fullScan: true, rustSemantic: true });
    assert.equal(report.rustSemantics.outcome, 'EXECUTION_ERROR');
    assert.equal(report.status, 'EXECUTION_ERROR');
    assert.equal(report.executionErrors[0].tool, 'rust-analyzer');
    assert.notEqual(report.verificationVerdict, 'SATISFIED');
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
