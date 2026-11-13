import assert from 'node:assert/strict';
import test from 'node:test';
import { findArchitecturePaths } from '../src/architecture-paths.mjs';
import { buildArchitectureView } from '../src/architecture-view.mjs';

test('independent transitive-closure oracle agrees with directed paths and SCCs on 40 seeded graphs', () => {
  let seed = 78123;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let sample = 0; sample < 40; sample++) {
    const size = 6, closure = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i === j));
    const symbols = Array.from({ length: size }, (_, i) => ({ id: `s${i}`, name: `s${i}`, kind: 'function', file: `src/m${i}/file.js`, zone: 'prod', roles: [], startLine: 1, endLine: 2 }));
    const graph = { files: symbols.map(s => ({ file: s.file, zone: 'prod' })), symbolById: new Map(symbols.map(s => [s.id, s])), outEdgeDetails: new Map(), stateOwnership: new Map(), crossBridges: [] };
    const direct = Array.from({ length: size }, () => Array(size).fill(false));
    for (let from = 0; from < size; from++) for (let to = 0; to < size; to++) {
      if (random() > 0.20 || from === to) continue;
      const high = random() < 0.8;
      const edge = { fromId: `s${from}`, toId: `s${to}`, kind: high ? 'SEQ_CALL' : 'REGISTRATION',
        evidence: { file: symbols[from].file, line: 1 }, resolution: { mode: 'ORACLE', confidence: high ? 'HIGH' : 'MEDIUM' } };
      if (!graph.outEdgeDetails.has(edge.fromId)) graph.outEdgeDetails.set(edge.fromId, []);
      graph.outEdgeDetails.get(edge.fromId).push(edge);
      if (high) { closure[from][to] = true; direct[from][to] = true; }
    }
    // Floyd–Warshall is independent of the production BFS / iterative Kosaraju implementation.
    for (let k = 0; k < size; k++) for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) closure[i][j] ||= closure[i][k] && closure[k][j];
    for (let from = 0; from < size; from++) for (let to = 0; to < size; to++) {
      const result = findArchitecturePaths(graph, `s${from}`, `s${to}`, { maxHops: 6, maxPaths: 50 });
      assert.equal(Boolean(result.paths.length), closure[from][to], `sample ${sample}: ${from}->${to}`);
      for (const p of result.paths) {
        assert.equal(new Set(p.nodeIds).size, p.nodeIds.length);
        for (let i = 1; i < p.nodeIds.length; i++) assert.ok(direct[Number(p.nodeIds[i - 1].slice(8))][Number(p.nodeIds[i].slice(8))]);
      }
    }
    const expected = [], used = new Set();
    for (let i = 0; i < size; i++) if (!used.has(i)) {
      const group = [];
      for (let j = 0; j < size; j++) if (closure[i][j] && closure[j][i]) { group.push(`module:src/m${j}`); used.add(j); }
      if (group.length > 1) expected.push(group.sort());
    }
    const actual = buildArchitectureView(graph, { includeTopology: true }).topology.cycles.map(c => c.nodeIds);
    assert.deepEqual(actual.map(JSON.stringify).sort(), expected.map(JSON.stringify).sort());
  }
});
