import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildArchitectureView } from '../src/architecture-view.mjs';
import { relationshipSemantics, isExecutableRelation } from '../src/architecture-semantics.mjs';
import { findArchitecturePaths } from '../src/architecture-paths.mjs';
import { inspectArchitectureState } from '../src/architecture-state.mjs';
import { executeTool } from '../src/server.mjs';
import { clearFlowGraphCache } from '../src/graph-builder.mjs';

function fixture() {
  const symbols = [
    ['entry', 'src/ui/main.js', 'main'], ['process', 'src/core/run.js', 'run'],
    ['save', 'src/db/store.js', 'save'], ['duplicate', 'src/other/run.js', 'run'],
    ['test', 'test/check.js', 'check']
  ].map(([id, file, name]) => ({ id, file, name, zone: id === 'test' ? 'test' : 'prod', startLine: 1, endLine: 5, roles: [], isEntrySource: id === 'entry' }));
  const graph = { symbolById: new Map(symbols.map(s => [s.id, s])),
    files: symbols.map(s => ({ file: s.file, zone: s.zone })), outEdgeDetails: new Map(),
    stateOwnership: new Map([['core:threshold', { field: 'threshold', qualifiedField: 'core.threshold', writers: ['process'], readers: ['save'] }]]),
    crossBridges: [], reachableFromRuntimeSource: new Set(['entry', 'process']) };
  const edge = (fromId, toId, kind, confidence = 'HIGH') => {
    if (!graph.outEdgeDetails.has(fromId)) graph.outEdgeDetails.set(fromId, []);
    graph.outEdgeDetails.get(fromId).push({ fromId, toId, kind,
      evidence: { file: graph.symbolById.get(fromId).file, line: 3, reason: 'fixture source evidence' },
      resolution: { mode: 'EXACT_IMPORT', confidence, ...(confidence === 'AMBIGUOUS' ? { candidates: ['save', 'duplicate'] } : {}) } });
  };
  edge('entry', 'process', 'SEQ_CALL'); edge('process', 'save', 'SEQ_CALL');
  edge('save', 'entry', 'REGISTRATION', 'AMBIGUOUS'); edge('test', 'entry', 'SEQ_CALL');
  return { graph, edge };
}

test('module/file/symbol projections share source evidence and navigable IDs', () => {
  const { graph } = fixture();
  const overview = buildArchitectureView(graph);
  assert.equal(overview.nodes.length, 4);
  assert.equal(overview.edges.length, 3);
  const call = overview.edges.find(e => e.from === 'module:src/ui');
  assert.equal(call.to, 'module:src/core');
  assert.equal(call.evidence[0].file, 'src/ui/main.js');
  assert.equal(call.evidence[0].line, 3);
  assert.equal(call.confidence, 'HIGH');
  const module = overview.nodes.find(n => n.id === 'module:src/ui');
  const files = buildArchitectureView(graph, module.drillDown.arguments);
  assert.deepEqual(files.nodes.map(n => n.id), ['file:src/ui/main.js']);
  const symbols = buildArchitectureView(graph, files.nodes[0].drillDown.arguments);
  assert.deepEqual(symbols.nodes.map(n => n.id), ['symbol:entry']);
  assert.equal(symbols.nodes[0].runtimeEntry, true);
  assert.equal(symbols.nodes[0].runtimeReachability, 'STATIC_HIGH_CONFIDENCE_PATH');
  assert.ok(overview.edges.find(e => e.confidence === 'AMBIGUOUS').evidence[0].resolution.candidates);
  assert.ok(!overview.mermaid.includes('test/check'));
});

test('focused traversal respects direction/depth and terminates on cycles', () => {
  const { graph } = fixture();
  const view = opts => buildArchitectureView(graph, { level: 'file', focus: 'src/ui/main.js', ...opts });
  assert.deepEqual(view({ depth: 0 }).nodes.map(n => n.label), ['src/ui/main.js']);
  assert.deepEqual(new Set(view({ depth: 1, direction: 'downstream' }).nodes.map(n => n.label)), new Set(['src/ui/main.js', 'src/core/run.js']));
  assert.deepEqual(new Set(view({ depth: 1, direction: 'upstream' }).nodes.map(n => n.label)), new Set(['src/ui/main.js', 'src/db/store.js']));
  assert.equal(view({ depth: 5 }).nodes.length, 3);
  assert.throws(() => view({ focus: 'run' }), /Ambiguous architecture focus/);
  assert.throws(() => buildArchitectureView(graph, { level: 'symbol', focus: 'run' }), /Ambiguous architecture focus/);
  assert.throws(() => view({ focus: 'does-not-exist' }), /not found/);
});

test('bounded views expose exact omissions, stable pages, and no dangling endpoints', () => {
  const { graph, edge } = fixture();
  for (let i = 0; i < 6; i++) edge('entry', 'process', 'SEQ_CALL');
  const view = buildArchitectureView(graph, { maxNodes: 2, maxEdges: 1 });
  assert.equal(view.coverage.matchedNodes, 4);
  assert.equal(view.coverage.omittedNodes, 2);
  assert.equal(view.coverage.nextNodeOffset, 2);
  const next = buildArchitectureView(graph, { maxNodes: 2, nodeOffset: 2 });
  assert.equal(next.coverage.nextNodeOffset, null);
  assert.equal(new Set([...view.nodes, ...next.nodes].map(n => n.id)).size, 4);
  const all = buildArchitectureView(graph, { maxNodes: 40, maxEdges: 1 });
  assert.equal(all.coverage.omittedEdges, 2);
  assert.equal(all.coverage.nextEdgeOffset, 1);
  const secondEdge = buildArchitectureView(graph, { maxEdges: 1, edgeOffset: 1 });
  assert.notEqual(secondEdge.edges[0].id, all.edges[0].id);
  for (const e of all.edges) for (const id of [e.from, e.to]) assert.ok(all.nodes.some(n => n.id === id));
  const full = buildArchitectureView(graph);
  const repeated = full.edges.find(e => e.from === 'module:src/ui');
  assert.equal(repeated.evidenceCount, 7);
  assert.equal(repeated.omittedEvidenceCount, 4);
  assert.equal(repeated.evidence.length, 3);
  assert.deepEqual(full, buildArchitectureView(graph));
  const empty = buildArchitectureView(graph, { nodeOffset: 100 });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.coverage.omittedNodes, 4);
});

test('state ownership and missing protocol peers retain explicit uncertainty', () => {
  const { graph } = fixture();
  graph.crossBridges.push({ fromFile: 'src/ui/main.js', fromSymbol: 'main', fromLine: 2,
    kind: 'TAURI_IPC', contract: 'invoke("missing")', status: 'MISSING_HANDLER' });
  const view = buildArchitectureView(graph, { level: 'symbol' });
  assert.ok(view.nodes.some(n => n.id === 'state:core:threshold'));
  assert.ok(view.edges.some(e => e.kind === 'STATE_WRITE' && e.from === 'symbol:process' && e.certainty === 'CANDIDATE'));
  assert.ok(view.edges.some(e => e.kind === 'STATE_READ' && e.to === 'symbol:save'));
  const unresolved = view.edges.find(e => e.kind === 'PROTOCOL_BRIDGE');
  assert.equal(unresolved.status, 'MISSING_HANDLER');
  assert.ok(view.nodes.some(n => n.id === unresolved.to && n.kind === 'UNRESOLVED_ENDPOINT'));
  assert.ok(view.mermaid.includes('-.->'));
  assert.ok(view.mermaid.includes('&quot;missing&quot;'));
});

test('empty source files remain discoverable through module and file drill-down', () => {
  const { graph } = fixture();
  graph.files.push({ file: 'src/empty/empty.js', zone: 'prod' });
  const files = buildArchitectureView(graph, { level: 'file', focus: 'module:src/empty', depth: 0 });
  assert.equal(files.nodes.length, 1);
  const symbols = buildArchitectureView(graph, files.nodes[0].drillDown.arguments);
  assert.equal(symbols.nodes.length, 0);
  assert.equal(symbols.coverage.matchedNodes, 0);
});

test('large overviews expose every module through pagination and preserve analysis limits', () => {
  const { graph } = fixture();
  for (let i = 0; i < 55; i++) graph.files.push({ file: `src/module-${i}/empty.js`, zone: 'prod' });
  graph.analysisLimitations = Array.from({ length: 23 }, (_, i) => ({ kind: 'UNRESOLVED_CONFIG', reason: `config ${i}` }));
  const seen = new Set();
  let nodeOffset = 0;
  do {
    const view = buildArchitectureView(graph, { nodeOffset, maxNodes: 10 });
    for (const node of view.nodes) { assert.ok(!seen.has(node.id)); seen.add(node.id); }
    assert.equal(view.scope.analysisLimitationsCount, 23);
    assert.equal(view.scope.omittedAnalysisLimitations, 3);
    nodeOffset = view.coverage.nextNodeOffset;
  } while (nodeOffset !== null);
  assert.equal(seen.size, 59);
});

test('default overview prioritizes source modules over numerous unresolved endpoints', () => {
  const { graph } = fixture();
  graph.crossBridges = Array.from({ length: 80 }, (_, i) => ({ fromFile: 'src/ui/main.js', fromSymbol: 'main', fromLine: 2,
    kind: 'TAURI_IPC', contract: `invoke-${i}`, status: 'MISSING_HANDLER' }));
  const view = buildArchitectureView(graph, { maxNodes: 4 });
  assert.equal(view.nodes.length, 4);
  assert.ok(view.nodes.every(n => n.kind === 'MODULE'));
  assert.equal(view.coverage.omittedNodes, 80);
});

test('coarse projections count internal evidence instead of implying it is absent', () => {
  const { graph, edge } = fixture();
  edge('entry', 'entry', 'SEQ_CALL');
  assert.equal(buildArchitectureView(graph).coverage.collapsedInternalRelations, 1);
  const symbol = buildArchitectureView(graph, { level: 'symbol', focus: 'symbol:entry', depth: 0 });
  assert.ok(symbol.edges.some(e => e.from === e.to));
});

test('independent edge pagination includes cross-page endpoints and complete evidence', () => {
  const { graph, edge } = fixture();
  for (let i = 0; i < 7; i++) edge('entry', 'process', 'SEQ_CALL');
  const first = buildArchitectureView(graph, { maxNodes: 1, maxEdges: 1, edgeScope: 'all-matched' });
  const seen = new Set();
  let edgeOffset = 0;
  do {
    const page = buildArchitectureView(graph, { maxNodes: 1, maxEdges: 1, edgeScope: 'all-matched', edgeOffset, expectedGraphId: first.graphId });
    for (const e of page.edges) {
      assert.ok(!seen.has(e.id)); seen.add(e.id);
      const ids = new Set([...page.nodes, ...page.boundaryNodes].map(n => n.id));
      assert.ok(ids.has(e.from) && ids.has(e.to));
    }
    edgeOffset = page.coverage.nextEdgeOffset;
  } while (edgeOffset !== null);
  assert.equal(seen.size, first.coverage.totalEdges);
  const relation = buildArchitectureView(graph).edges.find(e => e.from === 'module:src/ui');
  const evidence = [];
  let evidenceOffset = 0;
  do {
    const result = buildArchitectureView(graph, { edgeId: relation.id, evidenceOffset, maxEvidence: 2 }).relationEvidence;
    evidence.push(...result.evidence);
    evidenceOffset = result.nextEvidenceOffset;
  } while (evidenceOffset !== null);
  assert.equal(evidence.length, 8);
  edge('entry', 'save', 'SEQ_CALL');
  assert.throws(() => buildArchitectureView(graph, { expectedGraphId: first.graphId }), /graph changed/);
});

test('large candidate sets have bounded previews and lossless candidate pagination', () => {
  const { graph } = fixture();
  const record = graph.outEdgeDetails.get('save')[0];
  record.resolution.candidates = Array.from({ length: 101 }, (_, i) => `candidate-${i}`);
  const view = buildArchitectureView(graph);
  const edge = view.edges.find(e => e.confidence === 'AMBIGUOUS');
  assert.equal(edge.evidence[0].resolution.candidates.length, 8);
  assert.equal(edge.evidence[0].resolution.omittedCandidates, 93);
  const all = [];
  let candidateOffset = 0;
  do {
    const evidence = buildArchitectureView(graph, { edgeId: edge.id, maxEvidence: 1, maxCandidates: 20, candidateOffset }).relationEvidence.evidence[0];
    all.push(...evidence.resolution.candidates);
    candidateOffset = evidence.resolution.nextCandidateOffset;
  } while (candidateOffset !== null);
  assert.deepEqual(all, record.resolution.candidates);
});

test('topology and impact use the full projection and separate candidate-only connections', () => {
  const { graph, edge } = fixture();
  const before = buildArchitectureView(graph, { includeTopology: true, maxNodes: 1 });
  assert.equal(before.topology.counts.cycles, 0); // uncertain registration must not form a confirmed cycle
  assert.equal(before.topology.counts.isolatedSourceNodes, 1);
  const impact = buildArchitectureView(graph, { level: 'file', focus: 'src/db/store.js', impact: true }).impact;
  assert.ok(impact.upstream.highConfidence.some(n => n.id === 'file:src/ui/main.js' && n.hops === 2));
  assert.ok(impact.downstream.candidateOnly.some(n => n.id === 'file:src/ui/main.js'));
  assert.equal(impact.downstream.highConfidence.length, 0);
  edge('save', 'entry', 'SEQ_CALL');
  const after = buildArchitectureView(graph, { includeTopology: true }).topology;
  assert.equal(after.counts.cycles, 1);
  assert.equal(after.cycles[0].totalNodes, 3);
  assert.throws(() => buildArchitectureView(graph, { impact: true }), /requires a focus/);
});

test('real trace impact is rooted in the exact requested function', () => workspace(root => {
  const trace = executeTool('flow_trace', { workspaceRoot: root, target: 'run', impact: true });
  assert.equal(trace.architecture.impact.seedIds.length, 1);
  assert.ok(trace.architecture.impact.upstream.highConfidence.some(n => /main/.test(n.id)));
}));

function workspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-architecture-'));
  try {
    const files = { 'package.json': '{"type":"module"}',
      'src/ui/main.mjs': 'import { run } from "../core/run.mjs";\nexport function main() { return run(); }\nmain();\n',
      'src/core/run.mjs': 'export function run() { return 42; }\n' };
    for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
    fn(root);
  } finally { clearFlowGraphCache(); fs.rmSync(root, { recursive: true, force: true }); }
}
const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

test('relationship semantics never turn registration, state or membership into executable calls', () => {
  for (const kind of ['CONTAINS', 'IMPLEMENTS', 'REGISTRATION', 'STATE_RW', 'STATE_READ', 'STATE_WRITE', 'IMPORT', 'UNKNOWN']) {
    assert.equal(isExecutableRelation({ kind, confidence: 'HIGH' }), false, kind);
  }
  assert.equal(relationshipSemantics('BRANCH_DISPATCH'), 'CONTROL_CALL');
  assert.equal(isExecutableRelation({ kind: 'PROTOCOL_BRIDGE', status: 'MISSING_HANDLER' }), false);
  assert.equal(isExecutableRelation({ kind: 'SEQ_CALL' }), true);
  const view = buildArchitectureView(fixture().graph);
  assert.equal(view.edges.find(e => e.kind === 'REGISTRATION').semantics, 'REGISTRATION');
});

test('task paths return directed source evidence without treating state or registration as calls', () => {
  const { graph, edge } = fixture();
  const result = findArchitecturePaths(graph, 'main', 'save');
  assert.equal(result.status, 'PATHS_FOUND');
  assert.deepEqual(result.paths[0].nodeIds, ['symbol:entry', 'symbol:process', 'symbol:save']);
  assert.equal(result.edges[0].evidence[0].line, 3);
  assert.equal(findArchitecturePaths(graph, 'save', 'main').status, 'NO_STATIC_PATH_FOUND');
  assert.equal(findArchitecturePaths(graph, 'save', 'main', { includeCandidates: true }).status, 'NO_STATIC_PATH_FOUND');
  const candidate = findArchitecturePaths(graph, 'save', 'main', { includeCandidates: true, pathMode: 'relationships' });
  assert.equal(candidate.paths[0].certainty, 'CANDIDATE');
  edge('save', 'entry', 'SEQ_CALL');
  const cyclic = findArchitecturePaths(graph, 'main', 'save', { maxPaths: 20 });
  assert.equal(cyclic.paths.length, 1);
  assert.equal(cyclic.search.complete, true);
  assert.throws(() => findArchitecturePaths(graph, 'run', 'save'), /Ambiguous/);
});

test('path search reports depth, count and work limits rather than claiming disconnection', () => {
  const { graph, edge } = fixture();
  const short = findArchitecturePaths(graph, 'main', 'save', { maxHops: 1 });
  assert.equal(short.paths.length, 0);
  assert.equal(short.search.depthLimited, true);
  assert.equal(short.search.complete, false);
  edge('entry', 'save', 'SEQ_CALL');
  const limited = findArchitecturePaths(graph, 'main', 'save', { maxPaths: 1 });
  assert.equal(limited.paths[0].hops, 1);
  assert.equal(limited.search.pathLimited, true);
  const budget = findArchitecturePaths(graph, 'main', 'save', { searchBudget: 1 });
  assert.equal(budget.search.budgetLimited, true);
  assert.equal(budget.search.complete, false);
  assert.ok(budget.search.queuedStates <= 1);
});

test('state queries preserve scoped ambiguity, owners and read/write-only evidence', () => {
  const { graph } = fixture();
  graph.stateOwnership.set('other.threshold', { field: 'threshold', qualifiedField: 'other.threshold', writers: ['duplicate'], readers: [] });
  const ambiguous = inspectArchitectureState(graph, 'threshold');
  assert.equal(ambiguous.status, 'AMBIGUOUS_STATE');
  assert.equal(ambiguous.states.length, 2);
  const exact = inspectArchitectureState(graph, 'state:core:threshold', { maxOwners: 1 });
  assert.equal(exact.states[0].writers[0].id, 'symbol:process');
  assert.equal(exact.states[0].readers[0].id, 'symbol:save');
  assert.equal(exact.states[0].readers[0].persistenceHint, 'SAVE_NAME_HEURISTIC');
  assert.equal(inspectArchitectureState(graph, 'other.threshold').states[0].classification, 'WRITE_ONLY_STATIC_EVIDENCE');
  assert.equal(inspectArchitectureState(graph, 'absent').status, 'NO_STATIC_STATE_FOUND');
  const first = inspectArchitectureState(graph, 'threshold', { maxStates: 1 });
  assert.equal(first.coverage.omitted, 1);
  assert.equal(first.coverage.nextStateOffset, 1);
  assert.equal(inspectArchitectureState(graph, 'threshold', { maxStates: 1, stateOffset: 1 }).coverage.nextStateOffset, null);
});

test('state parser records actual owners and removing a reader changes the state query', () => workspace(root => {
  const file = path.join(root, 'src/core/run.mjs');
  fs.writeFileSync(file, 'export class Settings {\n set(value) { this.threshold = value; }\n get() { return this.threshold; }\n}\n');
  const before = executeTool('flow_trace', { workspaceRoot: root, target: 'Settings.threshold', inspectState: true });
  assert.equal(before.stateImpact.status, 'STATE_FOUND');
  assert.ok(before.stateImpact.states[0].writers.some(w => w.name === 'set'));
  assert.ok(before.stateImpact.states[0].readers.some(r => r.name === 'get'));
  fs.writeFileSync(file, 'export class Settings {\n set(value) { this.threshold = value; }\n}\n');
  clearFlowGraphCache();
  const after = executeTool('flow_trace', { workspaceRoot: root, target: 'Settings.threshold', inspectState: true });
  assert.equal(after.stateImpact.states[0].classification, 'WRITE_ONLY_STATIC_EVIDENCE');
}));

test('explicit module boundaries combine directories, retain evidence and refresh config-only changes', () => workspace(root => {
  const config = path.join(root, '.flowguard-architecture.json');
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, modules: [{ id: 'business', name: '业务处理', layer: 'DOMAIN', paths: ['src/ui', 'src/core'] }] }));
  const args = { workspaceRoot: root };
  const before = executeTool('flow_overview', args).architecture;
  assert.equal(before.nodes.length, 1);
  assert.equal(before.nodes[0].id, 'module:business');
  assert.equal(before.nodes[0].grouping, 'EXPLICIT_CONFIG');
  assert.equal(before.nodes[0].layerBasis, 'EXPLICIT_CONFIG');
  assert.equal(before.nodes[0].packages[0].manifest, 'package.json');
  const files = executeTool('flow_overview', { ...args, ...before.nodes[0].drillDown.arguments }).architecture;
  assert.equal(files.nodes.length, 2);
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, modules: [{ id: 'frontend', paths: ['src/ui'] }] }));
  const after = executeTool('flow_overview', args).architecture;
  assert.deepEqual(new Set(after.nodes.map(n => n.id)), new Set(['module:frontend', 'module:src/core']));
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, modules: [{ id: 'bad', paths: ['../outside'] }] }));
  assert.throws(() => executeTool('flow_overview', args), /invalid or conflicting/);
}));

test('nearest nested package owns each file without merging sibling packages', () => workspace(root => {
  fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/core/package.json'), '{"name":"core","type":"module","exports":"./run.mjs"}');
  const files = executeTool('flow_overview', { workspaceRoot: root, level: 'file' }).architecture;
  assert.equal(files.nodes.find(n => n.label === 'src/core/run.mjs').packages[0].manifest, 'src/core/package.json');
  assert.equal(files.nodes.find(n => n.label === 'src/ui/main.mjs').packages[0].manifest, 'package.json');
}));

test('file dependencies include unused imports, side effects and re-exports without inventing calls', () => workspace(root => {
  const file = path.join(root, 'src/ui/main.mjs');
  fs.writeFileSync(file, [
    'import "../core/run.mjs";',
    'export { run } from "../core/run.mjs";',
    'const text = "import ghost from \'../ghost.mjs\'";',
    '// import fake from "../fake.mjs";',
    'import external from "external-package";',
    'import missing from "../missing.mjs";',
    'const later = () => import("../core/run.mjs");',
    'export function main() { return text; }'
  ].join('\n'));
  clearFlowGraphCache();
  const view = executeTool('flow_overview', { workspaceRoot: root, level: 'file' }).architecture;
  const dependencies = view.edges.filter(e => e.kind === 'IMPORT');
  const linked = dependencies.find(e => e.to === 'file:src/core/run.mjs');
  assert.equal(linked.evidenceCount, 3);
  assert.deepEqual(linked.evidence.map(e => e.line), [1, 2, 7]);
  assert.equal(linked.semantics, 'DEPENDENCY');
  assert.ok(view.nodes.some(n => n.label === 'external-package' && n.status === 'EXTERNAL_OR_UNRESOLVED'));
  assert.ok(view.nodes.some(n => n.label === '../missing.mjs' && n.status === 'UNRESOLVED_LOCAL'));
  assert.ok(!view.nodes.some(n => /ghost|fake/.test(n.label)));
  const modules = executeTool('flow_overview', { workspaceRoot: root }).architecture;
  assert.ok(modules.nodes.some(n => n.kind === 'UNRESOLVED_DEPENDENCY'));
  const pathResult = executeTool('flow_trace', { workspaceRoot: root, target: 'main', to: 'run' }).paths;
  assert.equal(pathResult.status, 'NO_STATIC_PATH_FOUND');
}));

test('resolved imports outside production remain explicit scoped boundaries', () => workspace(root => {
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/helper.mjs'), 'export function helper() {}');
  fs.writeFileSync(path.join(root, 'src/ui/main.mjs'), 'import { helper } from "../../test/helper.mjs";\n');
  clearFlowGraphCache();
  const view = executeTool('flow_overview', { workspaceRoot: root, level: 'file' }).architecture;
  assert.ok(view.nodes.some(n => n.kind === 'OUT_OF_SCOPE_DEPENDENCY' && n.status === 'OUTSIDE_PRODUCTION_SCOPE'));
  assert.ok(view.edges.some(e => e.status === 'OUTSIDE_PRODUCTION_SCOPE' && e.evidence[0].excludedTargets.includes('test/helper.mjs')));
}));

test('architecture diff reconstructs historical configuration and preserves the working tree', () => workspace(root => {
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const config = path.join(root, '.flowguard-architecture.json');
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, modules: [{ id: 'old-core', paths: ['src/core'] }] }));
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=FlowGuard test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
  const commit = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, modules: [{ id: 'new-core', paths: ['src/core'] }] }));
  fs.writeFileSync(path.join(root, 'src/ui/main.mjs'), 'export function main() { return 0; }\nmain();\n');
  const status = git(['status', '--porcelain']);
  const diff = executeTool('flow_overview', { workspaceRoot: root, level: 'module', baseRef: 'HEAD' }).architectureDiff;
  assert.equal(diff.baseline.commit, commit);
  assert.ok(diff.removedNodes.some(n => n.id === 'module:old-core'));
  assert.ok(diff.addedNodes.some(n => n.id === 'module:new-core'));
  assert.ok(diff.removedEdges.some(e => e.from === 'module:src/ui' && e.to === 'module:old-core'));
  assert.equal(git(['status', '--porcelain']), status);
  assert.throws(() => executeTool('flow_overview', { workspaceRoot: root, baseRef: 'nonexistent-ref' }));
}));

test('real parser paths are exposed through trace with a negative disconnected control', () => workspace(root => {
  const linked = executeTool('flow_trace', { workspaceRoot: root, target: 'main', to: 'run' });
  assert.equal(linked.paths.status, 'PATHS_FOUND');
  assert.ok(linked.paths.edges[0].evidence.some(e => e.file === 'src/ui/main.mjs'));
  fs.writeFileSync(path.join(root, 'src/ui/main.mjs'), 'export function main() { return 0; }\nmain();\n');
  clearFlowGraphCache();
  const disconnected = executeTool('flow_trace', { workspaceRoot: root, target: 'main', to: 'run' });
  assert.equal(disconnected.paths.status, 'NO_STATIC_PATH_FOUND');
}));

test('top-level imports cannot hide later executable calls and registration names cannot relabel direct calls', () => workspace(root => {
  const file = path.join(root, 'src/ui/main.mjs');
  fs.writeFileSync(file, 'import { run } from "../core/run.mjs";\nconsole.log(run());\n');
  const result = executeTool('flow_trace', { workspaceRoot: root, target: 'src/ui/main.mjs', to: 'run' });
  assert.equal(result.paths.status, 'PATHS_FOUND');
  assert.ok(result.paths.edges.some(e => e.kind === 'SEQ_CALL' && e.evidence[0].line === 2));
  fs.writeFileSync(file, 'import { run } from "../core/run.mjs";\nexport function provideValue() { return run(); }\n');
  clearFlowGraphCache();
  assert.equal(executeTool('flow_trace', { workspaceRoot: root, target: 'provideValue', to: 'run' }).paths.status, 'PATHS_FOUND');
  fs.writeFileSync(file, 'import { run } from "../core/run.mjs";\nconsole.log("no call");\n');
  clearFlowGraphCache();
  assert.equal(executeTool('flow_trace', { workspaceRoot: root, target: 'src/ui/main.mjs', to: 'run' }).paths.status, 'NO_STATIC_PATH_FOUND');
}));

test('real parser overview drill-down connects to exact symbol trace IDs', () => workspace(root => {
  const overview = executeTool('flow_overview', { workspaceRoot: root });
  assert.equal(overview.mermaidPipeline, overview.architecture.mermaid);
  assert.ok(overview.architecture.edges.some(e => e.from === 'module:src/ui' && e.to === 'module:src/core'));
  const files = executeTool('flow_overview', { workspaceRoot: root, level: 'file', focus: 'module:src/core', depth: 0 });
  const symbols = executeTool('flow_overview', { workspaceRoot: root, ...files.architecture.nodes[0].drillDown.arguments });
  const run = symbols.architecture.nodes.find(n => n.label === 'run');
  assert.equal(run.drillDown.arguments.workspaceRoot, root);
  const trace = executeTool('flow_trace', { workspaceRoot: root, ...run.drillDown.arguments, depth: 1, direction: 'upstream' });
  assert.equal(trace.matchCount, 1);
  assert.ok(trace.architecture.nodes.some(n => n.label === 'main'));
  assert.ok(trace.architecture.nodes.some(n => n.id === run.id));
  assert.equal(trace.traceCoverage.omitted, 0);
}));

test('CLI and stdio MCP transport expose equivalent queries and validate bounded inputs', () => workspace(root => {
  const args = { workspaceRoot: root, level: 'file', focus: 'src/ui/main.mjs', depth: 1, maxNodes: 3, maxEdges: 2 };
  const cli = spawnSync(process.execPath, [server, '--cli', 'overview', root, '--level', 'file', '--focus', args.focus,
    '--depth', '1', '--max-nodes', '3', '--max-edges', '2'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flow_overview', arguments: args } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flow_trace', arguments: { workspaceRoot: root, target: 'run', depth: -1 } } }
  ];
  const mcp = spawnSync(process.execPath, [server], { input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(mcp.status, 0, mcp.stderr);
  const responses = mcp.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(responses[0].result.tools.find(t => t.name === 'flow_overview').inputSchema.properties.level);
  assert.deepEqual(JSON.parse(responses[1].result.content[0].text).architecture, JSON.parse(cli.stdout).architecture);
  assert.equal(responses[2].result.isError, true);
  for (const invalid of [{ maxNodes: 0 }, { depth: 6 }, { level: 'bad' }, { nodeOffset: -1 }, { focus: '' }])
    assert.throws(() => executeTool('flow_overview', { workspaceRoot: root, ...invalid }));
  const invalid = spawnSync(process.execPath, [server, '--cli', 'overview', root, '--depth', '1.5'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 2);
  const paths = spawnSync(process.execPath, [server, '--cli', 'trace', root, 'main', '--to', 'run', '--max-hops', '3', '--max-paths', '2'], { encoding: 'utf8', windowsHide: true });
  assert.equal(paths.status, 0, paths.stderr);
  assert.equal(JSON.parse(paths.stdout).paths.status, 'PATHS_FOUND');
  const topology = spawnSync(process.execPath, [server, '--cli', 'overview', root, '--level', 'file', '--topology', '--edge-scope', 'all-matched', '--max-nodes', '1'], { encoding: 'utf8', windowsHide: true });
  assert.equal(topology.status, 0, topology.stderr);
  assert.ok(JSON.parse(topology.stdout).architecture.boundaryNodes.length > 0);
}));
