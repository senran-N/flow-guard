import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serializeGraphSnapshot, computeFlowGraphDiff } from '../src/graph-diff.mjs';
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from "../src/graph-builder.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";

function workspace(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-rust-receiver-audit-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    return fn(root);
  } finally {
    clearFlowGraphCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const find = (graph, file, name) => [...graph.symbolById.values()].find((symbol) => symbol.file === file && symbol.name === name);

test('removing a runtime callback registration is an incremental defect without claiming prior execution', () => workspace({
  'Cargo.toml': '[package]\nname="registration-delta"\nversion="0.1.0"\n',
  'src/main.rs': 'mod callbacks;\nfn register(callback: fn()) {}\nfn main() { register(callbacks::event); }\n',
  'src/callbacks.rs': 'pub fn event() {}\n'
}, root => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const event = find(graph, 'src/callbacks.rs', 'event');
  assert.ok(!graph.reachableFromRuntimeSource.has(event.id));
  assert.ok(graph.possiblyReachableFromRuntimeSource.has(event.id));
  const before = serializeGraphSnapshot(graph);
  const file = path.join(root, 'src/main.rs');
  for (const replacement of ['register(callbacks::event);', 'register( callbacks::event );', 'callbacks::event();', '']) {
    fs.writeFileSync(file, `mod callbacks;\nfn register(callback: fn()) {}\nfn main() { ${replacement} }\n`);
    graph = buildWorkspaceFlowGraph(root, true);
    const diff = computeFlowGraphDiff(before, graph, { changedFiles: ['src/main.rs'] });
    assert.equal(diff.newlyOrphanedSymbols.some(s => s.classification === 'REMOVED_CALLBACK_REGISTRATION'), replacement === '');
    if (replacement === '') assert.ok(diff.impactedUntouchedFiles.includes('src/callbacks.rs'));
  }
}));

test('callback passed to a known direct invoker is executable; storage, branching and shadowing stay candidates', () => {
  for (const [body, executable] of [['callback();', true], ['', false], ['if ready { callback(); }', false], ['let callback = other; callback();', false]]) workspace({
    'Cargo.toml': '[package]\nname="callback-body"\nversion="0.1.0"\n',
    'src/main.rs': `fn invoke(callback: fn()) { ${body} }\npub fn event() {}\nfn main() { invoke(event); }\n`
  }, root => {
    const graph = buildWorkspaceFlowGraph(root, true), event = find(graph, 'src/main.rs', 'event');
    assert.equal(graph.reachableFromRuntimeSource.has(event.id), executable, body);
    assert.ok(graph.possiblyReachableFromRuntimeSource.has(event.id));
  });
});

test('creating an async callback invoker future does not execute its body', () => workspace({
  'Cargo.toml': '[package]\nname="async-callback"\nversion="0.1.0"\n',
  'src/main.rs': 'async fn invoke(callback: fn()) { callback(); }\npub fn event() {}\nfn main() { invoke(event); }\n'
}, root => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has(find(graph, 'src/main.rs', 'event').id));
}));

test('concrete generic fields and standard RefCell aliases resolve the inner method only', () => workspace({
  'Cargo.toml': '[package]\nname="field-types"\nversion="0.1.0"\n',
  'src/main.rs': `use std::cell::RefCell as Cell;
struct Worker;
struct Other;
struct Holder<T> { inner: Cell<T> }
impl Worker {
 pub fn execute(&self, value: u32) {}
}
impl Other {
 pub fn execute(&self, value: u32) {}
}
fn main() {
 let holder: Holder<Worker> = Holder { inner: Cell::new(Worker {}) };
 holder.inner.borrow_mut().execute(1);
}
`
}, root => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const methods = [...graph.symbolById.values()].filter(s => s.name === 'execute');
  assert.ok(graph.reachableFromRuntimeSource.has(methods.find(s => s.parentContainerName === 'Worker').id));
  assert.ok(!graph.reachableFromRuntimeSource.has(methods.find(s => s.parentContainerName === 'Other').id));
  const file = path.join(root, 'src/main.rs');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Holder<Worker>', 'Holder<Other>'));
  graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has([...graph.symbolById.values()].find(s => s.name === 'execute' && s.parentContainerName === 'Worker').id));
}));

test('a local type named RefCell is never assigned standard-library borrowing semantics', () => workspace({
  'Cargo.toml': '[package]\nname="fake-cell"\nversion="0.1.0"\n',
  'src/main.rs': `struct Worker;
struct RefCell<T> { field: T }
struct Outer { inner: RefCell<Worker> }
impl Worker {
 pub fn execute(&self) {}
}
impl Outer {
 pub fn relay(&self) { self.inner.borrow_mut().execute(); }
}
fn main() {
 let outer: Outer = Outer {};
 outer.relay();
}
`
}, root => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has(find(graph, 'src/main.rs', 'execute').id));
}));

const singletonMacro = `#[macro_export]
macro_rules! singleton {
 ($kind:ty, $instance:ident) => {
  impl $kind {
   pub fn global() -> &'static $kind { todo!() }
  }
 };
}
`;
test('declarative factory signatures resolve from the actual macro definition and invocation', () => workspace({
  'Cargo.toml': '[package]\nname="macro-signature"\nversion="0.1.0"\n',
  'src/main.rs': 'mod factory;\nmod worker;\nfn main() { worker::Worker::global().execute(); }\n',
  'src/factory.rs': singletonMacro,
  'src/worker.rs': `use crate::singleton;
pub struct Worker;
singleton!(Worker, INSTANCE);
impl Worker {
 pub fn execute(&self) {}
}
`
}, root => {
  let graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(graph.reachableFromRuntimeSource.has(find(graph, 'src/worker.rs', 'execute').id));
  const definition = path.join(root, 'src/factory.rs');
  fs.writeFileSync(definition, singletonMacro.replace("&'static $kind", 'Unknown'));
  graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has(find(graph, 'src/worker.rs', 'execute').id));
}));

test('cfg-selected or inaccessible macro signatures never establish executable edges', () => {
  for (const variant of ['definition-cfg', 'invocation-cfg', 'not-imported', 'wrong-name', 'module-cfg', 'ambiguous-arm']) workspace({
    'Cargo.toml': '[package]\nname="macro-negative"\nversion="0.1.0"\n',
    'src/main.rs': `${variant === 'module-cfg' ? '#[cfg(feature="on")]\n' : ''}mod factory;\nmod worker;\nfn main() { worker::Worker::global().execute(); }\n`,
    'src/factory.rs': (variant === 'definition-cfg' ? '#[cfg(feature="on")]\n' : '') + (variant === 'ambiguous-arm' ? singletonMacro.replace('macro_rules! singleton {', 'macro_rules! singleton { ($a:ty, $b:ident) => {};') : singletonMacro),
    'src/worker.rs': `${variant === 'not-imported' ? '' : 'use crate::singleton;'}
pub struct Worker;
${variant === 'invocation-cfg' ? '#[cfg(feature="on")]' : ''}
${variant === 'wrong-name' ? 'other' : 'singleton'}!(Worker, INSTANCE);
impl Worker {
 pub fn execute(&self) {}
}
`
  }, root => {
    const graph = buildWorkspaceFlowGraph(root, true);
    assert.ok(!graph.reachableFromRuntimeSource.has(find(graph, 'src/worker.rs', 'execute').id), variant);
  });
});

test('generic factory return and member delegation keep concrete arguments', () => workspace({
  'Cargo.toml': '[package]\nname="generic-return"\nversion="0.1.0"\n',
  'src/main.rs': `struct Worker;
struct Holder<T> { inner: T }
impl<T> Holder<T> {
 fn new() -> Self { todo!() }
 fn get(&self) -> &T { &self.inner }
}
impl Worker {
 pub fn execute(&self) {}
}
fn main() { Holder::<Worker>::new().get().execute(); }
`
}, root => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(graph.reachableFromRuntimeSource.has(find(graph, 'src/main.rs', 'execute').id));
}));

test("Rust candidate test-zone references stay inconclusive while direct dependencies still violate", () => workspace({
  "Cargo.toml": '[package]\nname = "test-zone-candidate"\nversion = "0.1.0"\n',
  "src/main.rs": '#[path = "../tests/helper.rs"]\nmod feature_test;\nfn register(callback: fn()) {}\nfn main() { register(feature_test::expand); }\n',
  "tests/helper.rs": 'pub fn expand() {}\n'
}, (root) => {
  for (const [body, expected] of [
    ['register(feature_test::expand);', "INCONCLUSIVE"],
    ['feature_test::expand();', "VIOLATED"],
    ['register(feature_test::expand); feature_test::expand();', "VIOLATED"]
  ]) {
    fs.writeFileSync(path.join(root, "src/main.rs"), `#[path = "../tests/helper.rs"]\nmod feature_test;\nfn register(callback: fn()) {}\nfn main() { ${body} }\n`);
    const report = verifyWorkspaceFlow(root, { fullScan: true });
    const diagnostics = report.wiringReport.obligations.filter((item) => item.station === "SANDBOX_DEPENDENCY");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].status, expected);
    assert.equal(report.summary.sandboxReverseDependencyLeaks, expected === "VIOLATED" ? 1 : 0);
  }
}));

test("Rust new is an associated function and resolves its qualified type without matching a sibling", () => workspace({
  "Cargo.toml": '[package]\nname = "constructor-path"\nversion = "0.1.0"\n',
  "src/main.rs": 'mod a;\nmod b;\nfn main() { a::Worker::new(); }\n',
  "src/a.rs": 'pub struct Worker;\nimpl Worker {\n pub fn new() -> Self { Self {} }\n}\n',
  "src/b.rs": 'pub struct Worker;\nimpl Worker {\n pub fn new() -> Self { Self {} }\n}\n'
}, (root) => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const main = find(graph, "src/main.rs", "main");
  const a = find(graph, "src/a.rs", "new");
  const b = find(graph, "src/b.rs", "new");
  assert.ok(graph.outEdges.get(main.id).has(a.id));
  assert.ok(!graph.outEdges.get(main.id).has(b.id));
  assert.ok(graph.reachableFromRuntimeSource.has(a.id));
  fs.writeFileSync(path.join(root, "src/main.rs"), 'mod a;\nmod b;\nfn main() {}\n');
  graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has(find(graph, "src/a.rs", "new").id));
}));

test("qualified Rust callback arguments are exact candidates, never proven calls", () => workspace({
  "Cargo.toml": '[package]\nname = "callback-path"\nversion = "0.1.0"\n',
  "src/main.rs": `mod a;
mod b;
fn register(callback: fn()) {}
pub fn expand() {}
fn main() { register(a::expand); }
`,
  "src/a.rs": 'pub fn expand() {}\n',
  "src/b.rs": 'pub fn expand() {}\n'
}, (root) => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const main = find(graph, "src/main.rs", "main");
  const a = find(graph, "src/a.rs", "expand");
  const b = find(graph, "src/b.rs", "expand");
  const sameFile = find(graph, "src/main.rs", "expand");
  const edge = graph.outEdgeDetails.get(main.id).find((item) => item.toId === a.id);
  assert.equal(edge.kind, "REGISTRATION");
  assert.equal(edge.resolution.mode, "RUST_CALLBACK_REFERENCE");
  assert.equal(edge.resolution.confidence, "MEDIUM");
  assert.ok(!graph.outEdges.get(main.id).has(b.id));
  assert.ok(!graph.outEdges.get(main.id).has(sameFile.id), "a qualified callback must not lose its module path");
  assert.ok(!graph.reachableFromRuntimeSource.has(a.id));
  assert.ok(graph.possiblyReachableFromRuntimeSource.has(a.id));
  const report = verifyWorkspaceFlow(root, { fullScan: true });
  assert.ok(report.wiringReport.obligations.some((item) => item.status === "INCONCLUSIVE" && /a.rs.*expand/.test(item.targetLocation)));
  for (const argument of ['b::expand', 'callback_variable', '|| a::expand']) {
    fs.writeFileSync(path.join(root, "src/main.rs"), `mod a;\nmod b;\nfn register(callback: fn()) {}\nfn main() { register(${argument}); }\n`);
    graph = buildWorkspaceFlowGraph(root, true);
    assert.ok(!graph.outEdges.get(find(graph, "src/main.rs", "main").id).has(find(graph, "src/a.rs", "expand").id));
  }
}));

test("Rust imported callback aliases keep their path and type/import syntax does not create calls", () => workspace({
  "Cargo.toml": '[package]\nname = "callback-alias"\nversion = "0.1.0"\n',
  "src/main.rs": `mod api;
use api::expand as callback;
pub struct Token;
fn register(callback: fn()) {}
fn main() {
 use api::expand;
 let value: Option<Token> = None;
 register(
   callback,
 );
}
`,
  "src/api.rs": 'pub fn expand() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const main = find(graph, "src/main.rs", "main");
  const expand = find(graph, "src/api.rs", "expand");
  const token = find(graph, "src/main.rs", "Token");
  const edges = graph.outEdgeDetails.get(main.id);
  assert.equal(edges.filter((edge) => edge.toId === expand.id).length, 1);
  assert.equal(edges.find((edge) => edge.toId === expand.id).resolution.mode, "RUST_CALLBACK_REFERENCE");
  assert.equal(edges.find((edge) => edge.toId === expand.id).evidence.line, 9);
  assert.ok(!graph.outEdges.get(main.id).has(token.id), "a generic type argument is not a runtime constructor");
  assert.ok(!graph.reachableFromRuntimeSource.has(expand.id));
}));

test("a same-named Rust field call preserves its receiver without dispatching on the outer type", () => workspace({
  "Cargo.toml": '[package]\nname = "field-receiver"\nversion = "0.1.0"\n',
  "src/main.rs": `mod inner;
struct Outer;
impl Outer {
 pub fn execute(&self) { self.inner.worker.execute(); }
 pub fn relay(&self) { self.inner.worker.execute(); }
}
fn main() {
 let value: Outer = Outer {};
 value.relay();
}
`,
  "src/inner.rs": 'pub struct Worker;\nimpl Worker {\n pub fn execute(&self) {}\n}\n'
}, (root) => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const outer = find(graph, "src/main.rs", "execute");
  const relay = find(graph, "src/main.rs", "relay");
  const inner = find(graph, "src/inner.rs", "execute");
  for (const caller of [outer, relay]) {
    assert.ok(caller.callSites.some((site) => site.rawCallee === "execute" && site.receiver === "self.inner.worker"));
    assert.ok(!graph.outEdges.get(caller.id).has(outer.id), "a field call cannot dispatch on Outer");
    assert.ok(!graph.outEdges.get(caller.id).has(inner.id), "unresolved field types cannot create call edges");
  }
  assert.ok(inner.rustReceiverCandidates?.length);
  assert.ok(!graph.reachableFromRuntimeSource.has(inner.id));
  let report = verifyWorkspaceFlow(root, { fullScan: true });
  assert.ok(report.wiringReport.obligations.some((item) => item.status === "INCONCLUSIVE" && /inner.rs.*execute/.test(item.targetLocation)));
  fs.writeFileSync(path.join(root, "src/main.rs"), 'mod inner;\nfn main() {}\n');
  graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, "src/inner.rs", "execute").rustReceiverCandidates, undefined);
  report = verifyWorkspaceFlow(root, { fullScan: true });
  assert.ok(report.unwiredExports.some((item) => /inner.rs.*execute/.test(item.symbol)));
}));

test("receiver typing selects the annotated same-crate struct, not a same-named sibling", () => workspace({
  "Cargo.toml": "[package]\nname = \"audit\"\nversion = \"0.1.0\"\n",
  "src/main.rs": "mod a;\nmod b;\nfn main() {\n let worker: a::Worker = a::Worker {};\n worker.execute();\n}\n",
  "src/a.rs": "pub struct Worker;\nimpl Worker {\n pub fn execute(&self) {}\n}\n",
  "src/b.rs": "pub struct Worker;\nimpl Worker {\n pub fn execute(&self) {}\n}\n"
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const main = find(graph, "src/main.rs", "main");
  const a = find(graph, "src/a.rs", "execute");
  const b = find(graph, "src/b.rs", "execute");
  assert.ok(graph.outEdges.get(main.id).has(a.id));
  assert.ok(!graph.outEdges.get(main.id).has(b.id));
}));

test("self dispatch remains on its impl container, while a free-function chain stays unresolved", () => workspace({
  "Cargo.toml": "[package]\nname = \"audit\"\nversion = \"0.1.0\"\n",
  "src/main.rs": "mod worker;\nfn factory() -> worker::Worker { worker::Worker {} }\nfn main() { factory().execute(); }\n",
  "src/worker.rs": "pub struct Worker;\nimpl Worker {\n pub fn execute(&self) {}\n pub fn relay(&self) { self.execute(); }\n}\n"
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const relay = find(graph, "src/worker.rs", "relay");
  const execute = find(graph, "src/worker.rs", "execute");
  const main = find(graph, "src/main.rs", "main");
  assert.ok(graph.outEdges.get(relay.id).has(execute.id));
  assert.ok(!graph.outEdges.get(main.id).has(execute.id));
  assert.ok(graph.analysisLimitations.some((item) => item.kind === "RUST_RECEIVER_TYPE_UNRESOLVED" && item.file === "src/main.rs"));
}));

test("trait impl dispatch binds the concrete annotated type, not the trait declaration", () => workspace({
  "Cargo.toml": "[package]\nname = \"audit\"\nversion = \"0.1.0\"\n",
  "src/main.rs": "mod worker;\nfn main() {\n let value: worker::Worker = worker::Worker {};\n value.execute();\n}\n",
  "src/worker.rs": "pub trait Execute {\n fn execute(&self);\n}\npub struct Worker;\nimpl Execute for Worker {\n fn execute(&self) {}\n}\n"
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const main = find(graph, "src/main.rs", "main");
  const targets = [...(graph.outEdges.get(main.id) || [])].map((id) => graph.symbolById.get(id));
  assert.equal(targets.filter((symbol) => symbol.name === "execute").length, 1);
  assert.equal(targets.find((symbol) => symbol.name === "execute").parentContainerName, "Worker");
}));
