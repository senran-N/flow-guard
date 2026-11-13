import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from '../src/graph-builder.mjs';
import { buildArchitectureView } from '../src/architecture-view.mjs';
import { findArchitecturePaths } from '../src/architecture-paths.mjs';

const corpus = path.resolve(process.argv[2] || 'D:/Myproject/crack');
const output = path.resolve(process.argv[3] || 'benchmark/results/architecture-round9');
if (fs.existsSync(output)) throw new Error('Use a fresh evidence directory');
fs.mkdirSync(output, { recursive: true });
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = fs.readdirSync(path.join(engineRoot, 'src')).filter(f => f.endsWith('.mjs')).sort();
const engineManifest = () => Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(engineRoot, 'src', file), 'utf8'))]));
const initialManifest = engineManifest();
fs.mkdirSync(path.join(output, 'engine-snapshot'));
for (const file of sourceFiles) fs.copyFileSync(path.join(engineRoot, 'src', file), path.join(output, 'engine-snapshot', file));
fs.writeFileSync(path.join(output, 'engine-manifest.json'), JSON.stringify(initialManifest, null, 2));
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const results = [];
for (const name of ['fd', 'pinia', 'fastapi', 'gin', 'fmt', 'pot-desktop', 'bruno']) {
  const root = path.join(corpus, name), commit = git(root, ['rev-parse', 'HEAD']), status = git(root, ['status', '--porcelain']);
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    clearFlowGraphCache();
    const start = performance.now(), graph = buildWorkspaceFlowGraph(root), built = performance.now();
    const module = buildArchitectureView(graph, { includeTopology: true, edgeScope: 'all-matched', maxNodes: 500, maxEdges: 2000 });
    const file = buildArchitectureView(graph, { level: 'file', edgeScope: 'all-matched', maxNodes: 500, maxEdges: 2000 });
    const symbol = buildArchitectureView(graph, { level: 'symbol', maxNodes: 20, maxEdges: 30 });
    const defaultView = buildArchitectureView(graph);
    for (const view of [module, file, symbol]) {
      const ids = new Set([...view.nodes, ...view.boundaryNodes].map(n => n.id));
      for (const edge of view.edges) {
        assert.ok(ids.has(edge.from) && ids.has(edge.to));
        for (const evidence of edge.evidence) if (evidence.file) {
          const source = fs.readFileSync(path.join(root, evidence.file), 'utf8');
          assert.ok(Number.isInteger(evidence.line) && evidence.line >= 1 && evidence.line <= source.split(/\r?\n/).length, JSON.stringify(evidence));
        }
      }
    }
    // Check a resolved high-confidence call against actual declarations and source.
    const call = [...graph.outEdgeDetails.values()].flat().find(e => ['SEQ_CALL', 'BRANCH_DISPATCH'].includes(e.kind) && e.resolution?.confidence === 'HIGH' &&
      graph.symbolById.get(e.fromId)?.zone === 'prod' && graph.symbolById.get(e.toId)?.zone === 'prod');
    let witness = null;
    if (call) {
      const result = findArchitecturePaths(graph, `symbol:${call.fromId}`, `symbol:${call.toId}`, { maxHops: 1 });
      assert.equal(result.status, 'PATHS_FOUND');
      witness = { from: call.fromId, to: call.toId, evidence: call.evidence };
    }
    rounds.push({ round: round + 1, buildMs: Math.round(built - start), totalMs: Math.round(performance.now() - start),
      rssMiB: Math.round(process.memoryUsage().rss / 1048576), reportHash: digest([module, file, symbol]),
      defaultOutputBytes: Buffer.byteLength(JSON.stringify(defaultView)),
      module: module.coverage, file: file.coverage, symbol: symbol.coverage, witness });
    fs.writeFileSync(path.join(output, `${name}-${round + 1}.json`), JSON.stringify({ module, file, symbol }, null, 2));
    rounds.at(-1).outputBytes = fs.statSync(path.join(output, `${name}-${round + 1}.json`)).size;
  }
  assert.equal(rounds[0].reportHash, rounds[1].reportHash, `${name}: repeat mismatch`);
  assert.equal(git(root, ['rev-parse', 'HEAD']), commit);
  assert.equal(git(root, ['status', '--porcelain']), status);
  const result = { name, commit, statusHash: digest(status), unchanged: true, repeatConsistent: true, rounds };
  results.push(result);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
  process.stdout.write(JSON.stringify({ name, outcome: 'PASSED', rounds: rounds.map(r => ({ totalMs: r.totalMs, rssMiB: r.rssMiB })) }) + '\n');
}
assert.deepEqual(engineManifest(), initialManifest, 'Engine changed during validation');
fs.writeFileSync(path.join(output, 'REPORT.md'), '# Architecture round 9\n\n' +
  'Seven real repositories, two independent graph builds per repository. Complete query hashes match; returned edge endpoints and source evidence line bounds checked; original commits/worktrees unchanged. This checks repeatability and traceability, not overall semantic accuracy.\n\n' +
  '| Repository | First ms | Second ms | Ending RSS MiB |\n|---|---:|---:|---:|\n' +
  results.map(r => `| ${r.name} | ${r.rounds[0].totalMs} | ${r.rounds[1].totalMs} | ${Math.max(...r.rounds.map(x => x.rssMiB))} |`).join('\n') + '\n');
