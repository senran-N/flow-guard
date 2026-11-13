import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from '../src/graph-builder.mjs';

function workspace(source, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-rust-receivers-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "typed-fixture"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(root, 'src/main.rs'), source);
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); clearFlowGraphCache(); }
}
const declarations = `struct Worker;
impl Worker {
 pub fn execute(&self) {}
 pub fn step(&self) -> Self { Self {} }
 pub fn finish(&self) {}
}
struct Other;
impl Other {
 pub fn execute(&self) {}
 pub fn finish(&self) {}
}
`;
const symbol = (graph, name, parent) => [...graph.symbolById.values()].find((item) => item.name === name && (!parent || item.parentContainerName === parent));
const calls = (graph, caller, target, parent) => graph.outEdges.get(symbol(graph, caller).id)?.has(symbol(graph, target, parent).id) || false;

test('typed Rust parameters, annotated lets, literals and Self choose the matching concrete method', () => workspace(declarations + `
fn drive(worker: &Worker) { worker.execute(); }
fn main() {
 let first: Worker = Worker {};
 let second = Worker {};
 first.execute();
 second.execute();
 drive(&first);
}
`, (root) => {
  let graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(calls(graph, 'drive', 'execute', 'Worker'));
  assert.ok(calls(graph, 'main', 'execute', 'Worker'));
  assert.ok(!calls(graph, 'main', 'execute', 'Other'));
  fs.writeFileSync(path.join(root, 'src/main.rs'), declarations + '\nfn main() {}\n');
  graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!calls(graph, 'main', 'execute', 'Worker'));
  assert.ok(!graph.reachableFromRuntimeSource.has(symbol(graph, 'execute', 'Worker').id));
}));

test('a zero-argument receiver chain follows a declared return type without matching other containers', () => workspace(declarations + `
fn main() {
 let worker: Worker = Worker {};
 worker.step().finish();
}
`, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(calls(graph, 'main', 'step', 'Worker'));
  assert.ok(calls(graph, 'main', 'finish', 'Worker'));
  assert.ok(!calls(graph, 'main', 'finish', 'Other'));
}));

test('unknown, shadowed and generic Rust receivers stay unresolved', () => {
  for (const body of [
    'let worker = make_worker();\n worker.execute();',
    'let worker: Worker = Worker {};\n let worker = make_other();\n worker.execute();',
    'let worker: Worker = Worker {};\n for worker in others { worker.execute(); }'
  ]) workspace(declarations + `\nfn main() {\n ${body}\n}\n`, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    assert.ok(!calls(graph, 'main', 'execute', 'Worker'));
    assert.ok(!calls(graph, 'main', 'execute', 'Other'));
    assert.ok(graph.analysisLimitations.some((limit) => limit.kind === 'RUST_RECEIVER_TYPE_UNRESOLVED'));
  });
});

test('nested lexical shadowing does not change the outer typed receiver', () => workspace(declarations + `
fn main() {
 let worker: Worker = Worker {};
 { let worker: Other = Other {}; worker.execute(); }
 worker.execute();
}
`, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(calls(graph, 'main', 'execute', 'Worker'));
  assert.ok(calls(graph, 'main', 'execute', 'Other'));
}));

test('an unresolved receiver-chain tail never resolves to a same-named free function', () => workspace(declarations + `
fn finish() {}
fn main() {
 let worker = make_worker();
 worker.step().finish();
}
`, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const free = [...graph.symbolById.values()].find((item) => item.name === 'finish' && !item.parentContainerName);
  assert.ok(!graph.outEdges.get(symbol(graph, 'main').id).has(free.id));
  assert.ok(!calls(graph, 'main', 'finish', 'Worker'));
  assert.ok(graph.analysisLimitations.some((limit) => limit.kind === 'RUST_RECEIVER_TYPE_UNRESOLVED'));
}));

test('cfg-gated Rust targets are candidate paths and never unconditional runtime roots', () => workspace(`
#[cfg(feature = "experimental")]
pub fn guarded() {}
fn main() { guarded(); }
`, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const target = symbol(graph, 'guarded');
  const edge = graph.outEdgeDetails.get(symbol(graph, 'main').id).find((item) => item.toId === target.id);
  assert.equal(edge.resolution.mode, 'RUST_CONDITIONAL_PATH');
  assert.equal(edge.resolution.confidence, 'MEDIUM');
  assert.ok(!graph.reachableFromRuntimeSource.has(target.id));
  assert.ok(graph.possiblyReachableFromRuntimeSource.has(target.id));
  assert.ok(graph.analysisLimitations.some((limit) => limit.kind === 'RUST_CFG_ITEM_UNRESOLVED'));
}));
