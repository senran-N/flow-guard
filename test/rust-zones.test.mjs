import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWorkspaceFlowGraph, clearFlowGraphCache, assembleFlowGraph, cloneParsedFile } from '../src/graph-builder.mjs';
import { verifyWorkspaceFlow } from '../src/flow-verifier.mjs';
import { parseSourceFileContent } from '../src/file-parser.mjs';
import { rustTestCondition } from '../src/rust-zones.mjs';

const manifest = '[package]\nname = "module-zones"\nversion = "0.1.0"\n';
const workspace = (files, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-rust-zones-'));
  try {
    for (const [file, text] of Object.entries({ 'Cargo.toml': manifest, ...files })) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    return run(root);
  } finally { clearFlowGraphCache(); fs.rmSync(root, { recursive: true, force: true }); }
};
const find = (graph, file, name) => [...graph.symbolById.values()].find((symbol) => symbol.file === file && symbol.name === name);

test('Rust module membership overrides only a test filename and preserves attached test declarations', () => workspace({
  'src/lib.rs': '#![cfg_attr(test, allow(dead_code))]\n#![cfg_attr(docsrs, doc = "a,b", feature(doc_cfg))]\npub mod parser_test;\n',
  'src/parser_test.rs': `pub fn ordinary() {}
#[test]
fn unit() {}
pub fn immediately_after_test() {}
#[tokio::test]
async fn async_test() {}
#[cfg(all(test, feature = "test"))]
pub fn conditional_test() {}
`
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(graph.files.find((file) => file.file === 'src/parser_test.rs').zone, 'prod');
  for (const name of ['ordinary', 'immediately_after_test']) assert.equal(find(graph, 'src/parser_test.rs', name).zone, 'prod');
  for (const name of ['unit', 'async_test', 'conditional_test']) assert.equal(find(graph, 'src/parser_test.rs', name).zone, 'test');
  assert.equal(find(graph, 'src/parser_test.rs', 'ordinary').isPackageEntryExport, true);
}));

test('custom Cargo bin/lib roots including test suffixes establish exact module membership', () => workspace({
  'Cargo.toml': manifest + 'autobins = false\nautolib = false\n[[bin]]\nname = "tool"\npath = "cmd/tool_test.rs"\n[lib]\npath = "api/lib_test.rs"\n',
  'cmd/tool_test.rs': '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]\nmod feature_test;\nfn main() { feature_test::run(); }\n',
  'cmd/feature_test.rs': 'pub fn run() {}\n',
  'api/lib_test.rs': 'pub mod feature_test;\n',
  'api/feature_test.rs': 'pub fn api() {}\n',
  'src/main.rs': 'mod unused_test;\nfn main() {}\n',
  'src/unused_test.rs': 'pub fn unused() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, 'cmd/tool_test.rs', 'main').zone, 'prod');
  assert.ok(graph.reachableFromRuntimeSource.has(find(graph, 'cmd/feature_test.rs', 'run').id));
  assert.equal(find(graph, 'api/feature_test.rs', 'api').zone, 'prod');
  assert.equal(find(graph, 'src/unused_test.rs', 'unused').zone, 'test');
}));

test('cfg test-only module ancestry and file inner cfg do not become production', () => workspace({
  'src/lib.rs': `#[cfg(test)]
mod unit {
 mod child_test;
}
# [cfg(all(test, feature = "enabled"))]
mod support;
mod inner_test;
#[cfg(feature = "test")]
mod production_test;
`,
  'src/unit/child_test.rs': 'pub fn child() {}\n',
  'src/support.rs': 'pub fn support() {}\n',
  'src/inner_test.rs': '#![cfg(test)]\npub fn inner() {}\n',
  'src/production_test.rs': 'pub fn production() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  for (const [file, name] of [['src/unit/child_test.rs', 'child'], ['src/support.rs', 'support'], ['src/inner_test.rs', 'inner']]) {
    assert.equal(find(graph, file, name).zone, 'test');
  }
  assert.equal(find(graph, 'src/production_test.rs', 'production').zone, 'prod');
  assert.ok(!graph.reachableFromRuntimeSource.has(find(graph, 'src/production_test.rs', 'production').id));
}));

test('path modules in real test directories remain dependencies and ordinary renamed source is production', () => workspace({
  'src/main.rs': `#[path = "../tests/helper.rs"]
mod helper;
#[path = "normal_test.rs"]
mod normal;
fn main() { helper::run(); normal::normal(); }
`,
  'tests/helper.rs': 'pub fn run() {}\n',
  'src/normal_test.rs': 'pub fn normal() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, 'src/normal_test.rs', 'normal').zone, 'prod');
  assert.equal(find(graph, 'tests/helper.rs', 'run').zone, 'test');
  const report = verifyWorkspaceFlow(root, { fullScan: true });
  assert.ok(report.sandboxViolations.some((item) => /tests\/helper.rs/.test(item.illegalTarget)));
  assert.ok(!report.sandboxViolations.some((item) => /normal_test.rs/.test(item.illegalTarget)));
}));

test('one source file may be included through test and production paths without a name map hiding either declaration', () => workspace({
  'src/lib.rs': `#[cfg(test)]
#[path = "shared_test.rs"]
mod shared;
#[cfg(not(test))]
#[path = "shared_test.rs"]
mod shared;
`,
  'src/shared_test.rs': 'pub fn shared() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, 'src/shared_test.rs', 'shared').zone, 'prod');
  assert.ok(graph.analysisLimitations.some((item) => item.kind === 'RUST_CFG_MODULE_UNRESOLVED'));
}));

test('module edits recalculate zones without leaking promotion into parse caches or repeated graph assembly', () => workspace({
  'src/lib.rs': 'mod cached_test;\n',
  'src/cached_test.rs': 'pub fn cached() {}\n'
}, (root) => {
  let graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, 'src/cached_test.rs', 'cached').zone, 'prod');
  fs.writeFileSync(path.join(root, 'src/lib.rs'), '// removed module\n');
  graph = buildWorkspaceFlowGraph(root);
  assert.equal(find(graph, 'src/cached_test.rs', 'cached').zone, 'test');
  const raw = [parseSourceFileContent('mod cached_test;\n', 'src/lib.rs'), parseSourceFileContent('pub fn cached() {}\n', 'src/cached_test.rs')];
  graph = assembleFlowGraph(raw.map(cloneParsedFile), root);
  assert.equal(find(graph, 'src/cached_test.rs', 'cached').zone, 'prod');
  assert.equal(raw[1].zone, 'test');
  graph = assembleFlowGraph(graph.files.filter((file) => file.file !== 'src/lib.rs'), root);
  assert.equal(find(graph, 'src/cached_test.rs', 'cached').zone, 'test');
}));

test('complex unselected cfg and absent Cargo metadata cannot prove a production module path', () => {
  for (const condition of ['any(test, feature = "enabled")', 'not(all(test, feature = "enabled"))']) workspace({
    'src/lib.rs': `#[cfg(${condition})]\nmod uncertain_test;\n`,
    'src/uncertain_test.rs': 'pub fn uncertain() {}\n'
  }, (root) => {
    assert.equal(find(buildWorkspaceFlowGraph(root, true), 'src/uncertain_test.rs', 'uncertain').zone, 'test');
  });
  workspace({ 'Cargo.toml': '', 'src/main.rs': 'mod orphan_test;\nfn main() {}\n', 'src/orphan_test.rs': 'pub fn orphan() {}\n' }, (root) => {
    assert.equal(find(buildWorkspaceFlowGraph(root, true), 'src/orphan_test.rs', 'orphan').zone, 'test');
  });
  assert.equal(rustTestCondition('feature = "test"'), 'prod');
  assert.equal(rustTestCondition('any(test, all(test, feature="x"))'), 'test');
});

test('attribute strings are not test annotations and cfg_attr that can choose code remains uncertain', () => workspace({
  'src/lib.rs': `#[doc = "#[cfg(test)] mod fake; cfg_attr(test, cfg(test))"]
pub mod normal_test;
#[cfg_attr(feature = "enabled", doc = ")]", cfg(test))]
mod conditional_test;
`,
  'src/normal_test.rs': '#[doc = "#[test] "]\npub fn normal() {}\n',
  'src/conditional_test.rs': 'pub fn conditional() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, 'src/normal_test.rs', 'normal').zone, 'prod');
  assert.equal(find(graph, 'src/conditional_test.rs', 'conditional').zone, 'test');
}));

test('inline inner cfg stays test-only while adjacent ordinary functions remain production', () => workspace({
  'src/lib.rs': `pub mod unit {
 #![cfg(test)]
 pub fn unit_only() {}
 mod child_test;
}
#[cfg(test)]
mod external;
pub fn after_external_test_module() {}
`,
  'src/unit/child_test.rs': 'pub fn child() {}\n',
  'src/external.rs': 'pub fn external() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(find(graph, 'src/lib.rs', 'unit_only').zone, 'test');
  assert.equal(find(graph, 'src/unit/child_test.rs', 'child').zone, 'test');
  assert.equal(find(graph, 'src/lib.rs', 'after_external_test_module').zone, 'prod');
}));

test('nested path attributes and custom-root inline modules use the same module candidates as call resolution', () => workspace({
  'Cargo.toml': manifest + 'autobins = false\n[[bin]]\nname = "tool"\npath = "cmd/entry.rs"\n',
  'cmd/entry.rs': `mod inline {
 #[path = "worker_test.rs"]
 pub mod worker;
}
mod nested;
fn main() { inline::worker::run(); nested::deep::child::run(); }
`,
  'cmd/inline/worker_test.rs': 'pub fn run() {}\n',
  'cmd/nested.rs': 'pub mod deep {\n #[path = "worker_test.rs"]\n pub mod child;\n}\n',
  'cmd/nested/deep/worker_test.rs': 'pub fn run() {}\n',
  'cmd/deep/worker_test.rs': 'pub fn wrong() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const main = find(graph, 'cmd/entry.rs', 'main');
  for (const file of ['cmd/inline/worker_test.rs', 'cmd/nested/deep/worker_test.rs']) {
    const target = find(graph, file, 'run');
    assert.equal(target.zone, 'prod');
    assert.ok(graph.outEdges.get(main.id).has(target.id));
  }
  assert.equal(find(graph, 'cmd/deep/worker_test.rs', 'wrong').zone, 'test');
}));

test('an inline path attribute overrides the ordinary source stem without overriding deeper components', () => workspace({
  'src/main.rs': 'mod holder;\nfn main() { holder::outer::deep::child::run(); }\n',
  'src/holder.rs': '#[path = "renamed"]\npub mod outer {\n pub mod deep {\n  #[path = "child_test.rs"]\n  pub mod child;\n }\n}\n',
  'src/renamed/deep/child_test.rs': 'pub fn run() {}\n',
  'src/holder/renamed/deep/child_test.rs': 'pub fn wrong() {}\n'
}, (root) => {
  const graph = buildWorkspaceFlowGraph(root, true);
  const target = find(graph, 'src/renamed/deep/child_test.rs', 'run');
  assert.equal(target.zone, 'prod');
  assert.ok(graph.outEdges.get(find(graph, 'src/main.rs', 'main').id).has(target.id));
  assert.equal(find(graph, 'src/holder/renamed/deep/child_test.rs', 'wrong').zone, 'test');
}));
