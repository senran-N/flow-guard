import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildWorkspaceFlowGraph, assembleFlowGraph, cloneParsedFile, clearFlowGraphCache } from '../src/graph-builder.mjs';
import { parseSourceFileContent } from '../src/file-parser.mjs';
import { findArchitecturePaths } from '../src/architecture-paths.mjs';
import { buildArchitectureView } from '../src/architecture-view.mjs';

const corpus = path.resolve(process.argv[2] || 'D:/Myproject/crack');
const output = path.resolve(process.argv[3] || 'benchmark/results/architecture-source-audit');
if (fs.existsSync(output)) throw new Error('Use a fresh evidence directory');
fs.mkdirSync(output, { recursive: true });
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const results = [];
// Ground truth is the independently inspected source call/exact export, not another diagnostic.
for (const entry of [
  { name: 'fd', file: 'src/main.rs', from: 'main', to: 'run', needle: 'let result = run();', replacement: 'let result = Ok(ExitCode::Success);' },
  { name: 'gin', file: 'gin.go', from: 'Default', to: 'New', needle: 'engine := New()', replacement: 'engine := &Engine{}' }
]) {
  const root = path.join(corpus, entry.name), status = git(root, ['status', '--porcelain']);
  const source = fs.readFileSync(path.join(root, entry.file), 'utf8');
  assert.equal(source.split(entry.needle).length, 2);
  clearFlowGraphCache();
  const graph = buildWorkspaceFlowGraph(root);
  const find = name => [...graph.symbolById.values()].find(s => s.file === entry.file && s.name === name && s.kind !== 'module');
  const from = find(entry.from), to = find(entry.to);
  assert.ok(from && to);
  const control = findArchitecturePaths(graph, `symbol:${from.id}`, `symbol:${to.id}`, { maxHops: 1 });
  assert.equal(control.status, 'PATHS_FOUND');
  const mutantSource = source.replace(entry.needle, entry.replacement);
  const files = graph.files.map(f => f.file === entry.file ? parseSourceFileContent(mutantSource, f.file) : cloneParsedFile(f));
  const mutant = assembleFlowGraph(files, root);
  const deleted = findArchitecturePaths(mutant, `symbol:${from.id}`, `symbol:${to.id}`, { maxHops: 1 });
  assert.equal(deleted.status, 'NO_STATIC_PATH_FOUND');
  assert.equal(git(root, ['status', '--porcelain']), status);
  results.push({ ...entry, commit: git(root, ['rev-parse', 'HEAD']), sourceHash: crypto.createHash('sha256').update(source).digest('hex'),
    line: source.slice(0, source.indexOf(entry.needle)).split('\n').length, control: control.status, deletion: deleted.status, unchanged: true,
    limitation: 'In-memory source mutation checks static edge extraction; no claim of runtime regression coverage.' });
}
{
  const root = path.join(corpus, 'pinia'), file = 'packages/pinia/src/index.ts';
  const source = fs.readFileSync(path.join(root, file), 'utf8'), status = git(root, ['status', '--porcelain']);
  assert.ok(source.includes("export { createPinia, disposePinia } from './createPinia'"));
  clearFlowGraphCache();
  const view = buildArchitectureView(buildWorkspaceFlowGraph(root), { level: 'file', focus: file, depth: 1, edgeScope: 'all-matched', maxNodes: 500, maxEdges: 2000 });
  assert.ok(view.edges.some(e => e.kind === 'IMPORT' && e.from === `file:${file}` && e.to === 'file:packages/pinia/src/createPinia.ts'));
  assert.equal(git(root, ['status', '--porcelain']), status);
  results.push({ name: 'pinia', commit: git(root, ['rev-parse', 'HEAD']), file,
    sourceHash: crypto.createHash('sha256').update(source).digest('hex'), outcome: 'RE_EXPORT_DEPENDENCY_FOUND', unchanged: true });
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results }, null, 2));
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
