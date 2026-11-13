import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inferPackageBoundaries } from "../src/package-boundaries.mjs";
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from '../src/graph-builder.mjs';
import { verifyWorkspaceFlow } from '../src/flow-verifier.mjs';
import { parseSourceFileContent } from '../src/file-parser.mjs';
import { serializeGraphSnapshot, computeFlowGraphDiff } from '../src/graph-diff.mjs';

const entryPlan = name => ({ planId: 'entry-control', obligations: [{ id: 'ENTRY', station: 'ENTRY_WIRING', layer: 'L1_STRUCTURAL', required: true,
  checkSpec: { type: 'ENTRY_REACHABILITY', targetSymbol: name } }] });
const target = (graph, name) => [...graph.symbolById.values()].find(s => s.name === name);
const entryStatus = (root, name) => verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: entryPlan(name) }).wiringReport.obligations.find(o => o.id === 'ENTRY').status;

function withWorkspace(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-framework-boundaries-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("private React Email template packages are framework library surfaces", () => withWorkspace({
  "packages/emails/package.json": JSON.stringify({
    private: true,
    scripts: { build: "email build", export: "email export --outDir ../generated" },
    dependencies: { "react-email": "6.0.0" }
  }),
  "packages/emails/emails/welcome.tsx": "export function Welcome() {}",
  "packages/emails/src/Application.tsx": "export function Application() {}"
}, (root) => {
  const files = [{ file: "packages/emails/emails/welcome.tsx", lang: "ts" }, { file: 'packages/emails/src/Application.tsx', lang: 'ts' }];
  const boundaries = inferPackageBoundaries(root, files);
  assert.equal(boundaries.fileModes.get(files[0].file), "library");
  assert.ok(boundaries.libraryFiles.has(files[0].file));
  assert.equal(boundaries.fileModes.get(files[1].file), 'application');
}));

test("ordinary private React applications retain application entry requirements", () => withWorkspace({
  "package.json": JSON.stringify({ private: true, scripts: { dev: "vite" }, dependencies: { react: "19.0.0" } }),
  "src/App.tsx": "export function App() {}"
}, (root) => {
  const file = { file: "src/App.tsx", lang: "ts" };
  assert.equal(inferPackageBoundaries(root, [file]).fileModes.get(file.file), "application");
}));

test('automatic unused exports are advisory while explicit disconnected targets still fail', () => withWorkspace({
  'package.json': '{"private":true}',
  'src/main.ts': 'export function main() {}\n',
  'src/feature.ts': 'export function feature() {}\n'
}, root => {
  const report = verifyWorkspaceFlow(root, { fullScan: true });
  const auto = report.wiringReport.obligations.find(o => /feature/.test(o.targetLocation) && o.id.startsWith('AUTO-EXP'));
  assert.equal(auto.status, 'INCONCLUSIVE'); assert.equal(auto.required, false);
  assert.equal(entryStatus(root, 'feature'), 'VIOLATED');
}));

test('multiline Rust factory continuation follows concrete return type and deletion breaks explicit entry', () => withWorkspace({
  'Cargo.toml': '[package]\nname="factory"\nversion="0.1.0"\n',
  'src/main.rs': `struct Factory;\nstruct Worker;\nimpl Factory {\n fn global() -> Worker { Worker {} }\n}\nimpl Worker {\n pub fn execute(&self, value: u32) {}\n}\nfn main() {\n Factory::global()\n  .execute(1);\n}\n`
}, root => {
  let graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(graph.reachableFromRuntimeSource.has(target(graph, 'execute').id));
  assert.equal(entryStatus(root, 'execute'), 'SATISFIED');
  const file = path.join(root, 'src/main.rs');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Factory::global()\n  .execute(1);', ''));
  clearFlowGraphCache();
  assert.equal(entryStatus(root, 'execute'), 'VIOLATED');
}));

test('unknown Rust factory and field chains preserve candidates without inventing calls', () => withWorkspace({
  'Cargo.toml': '[package]\nname="unknown"\nversion="0.1.0"\n',
  'src/main.rs': 'struct Worker;\nimpl Worker {\n pub fn execute(&self, value: u32) {}\n}\nfn main() {\n External::global()\n  .execute(1);\n self.field.borrow_mut().execute(2);\n}\n'
}, root => {
  const graph = buildWorkspaceFlowGraph(root, true), method = target(graph, 'execute');
  assert.ok(method.rustReceiverCandidates?.length);
  assert.ok(!graph.reachableFromRuntimeSource.has(method.id));
  assert.equal(entryStatus(root, 'execute'), 'INCONCLUSIVE');
}));

test('Serde cross-module attributes resolve only imported targets and disappear after removal', () => withWorkspace({
  'Cargo.toml': '[package]\nname="serde-callback"\nversion="0.1.0"\n',
  'src/main.rs': 'mod config;\nmod codec;\nmod other;\nfn main() {}\n',
  'src/codec.rs': 'pub fn encode() {}\n',
  'src/other.rs': 'pub fn encode() {}\n',
  'src/config.rs': 'use crate::codec::encode;\n#[derive(Serialize)]\npub struct Config {\n #[serde(serialize_with = "encode")]\n field: String,\n}\n'
}, root => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const encode = [...graph.symbolById.values()].find(s => s.file === 'src/codec.rs' && s.name === 'encode');
  assert.ok(encode.frameworkCallbackCandidates?.length);
  assert.ok(!graph.reachableFromRuntimeSource.has(encode.id));
  assert.ok(![...graph.symbolById.values()].find(s => s.file === 'src/other.rs' && s.name === 'encode').frameworkCallbackCandidates);
  const config = path.join(root, 'src/config.rs');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('#[serde(serialize_with = "encode")]', '// #[serde(serialize_with = "encode")]'));
  graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(![...graph.symbolById.values()].find(s => s.file === 'src/codec.rs' && s.name === 'encode').frameworkCallbackCandidates);
}));

test('CodeMirror callbacks require the external base import and widget exposure', () => {
  const code = `import { WidgetType as Base } from '@codemirror/view';\nclass Label extends Base {\n eq(other: Label) { return true; }\n toDOM() { return document.createElement('span'); }\n}\nconst decoration = { widget: new Label() };\n`;
  assert.equal(parseSourceFileContent(code, 'src/editor.ts').frameworkCallbackFacts.length, 2);
  for (const negative of [code.replace('@codemirror/view', './fake'), code.replace('widget: new Label()', 'widget: null'), code.replace('extends Base', 'extends Other')]) {
    assert.equal(parseSourceFileContent(negative, 'src/editor.ts').frameworkCallbackFacts.length, 0);
  }
});

test('Homebrew install requires a Formula subclass within a formula path', () => {
  const code = 'class Package < Formula\n def install\n  bin.install "app"\n end\nend\n';
  assert.equal(parseSourceFileContent(code, 'pkg/brew/package.rb').frameworkCallbackFacts.length, 1);
  assert.equal(parseSourceFileContent(code.replace('< Formula', '< Other'), 'pkg/brew/package.rb').frameworkCallbackFacts.length, 0);
  assert.equal(parseSourceFileContent(code, 'src/package.rb').frameworkCallbackFacts.length, 0);
});

test('same-line mixed Rust chains and nested functions cannot borrow factory type evidence', () => withWorkspace({
  'Cargo.toml': '[package]\nname="mixed-chain"\nversion="0.1.0"\n',
  'src/main.rs': 'struct Factory;\nstruct Worker;\nimpl Factory {\n fn global() -> Worker { Worker {} }\n}\nimpl Worker {\n pub fn execute(&self, value: u32) {}\n}\nfn main() {\n Factory::global().execute(1); unknown().execute(2);\n fn unused() { Factory::global().execute(3); }\n}\n'
}, root => {
  const graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has(target(graph, 'execute').id));
}));

test('attribute text in a Rust string is not a Serde callback', () => {
  const code = 'fn main() { let text = r#"#[serde(serialize_with = "encode")]"#; }\npub fn encode() {}\n';
  assert.equal(parseSourceFileContent(code, 'src/main.rs').frameworkCallbackFacts.length, 0);
});

test('removing CodeMirror widget exposure preserves a structural registration regression', () => withWorkspace({
  'package.json': '{"private":true}',
  'src/editor.ts': `import { WidgetType } from '@codemirror/view';
class Label extends WidgetType {
 eq(other: Label) { return true; }
 toDOM() { return document.createElement('span'); }
}
export function main() { return { widget: new Label() }; }
`
}, root => {
  let graph = buildWorkspaceFlowGraph(root, true);
  const before = serializeGraphSnapshot(graph), file = path.join(root, 'src/editor.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('widget: new Label()', 'widget: null'));
  graph = buildWorkspaceFlowGraph(root, true);
  const diff = computeFlowGraphDiff(before, graph, { changedFiles: ['src/editor.ts'] });
  assert.equal(diff.newlyOrphanedSymbols.filter(s => s.classification === 'REMOVED_CALLBACK_REGISTRATION').length, 2);
}));
