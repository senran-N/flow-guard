// Compiler-backed resolution oracle for the Rust module grammar. This fixture
// validates the analyzer against rustc; it does not execute an upstream app.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [rootArg, phase = "phase9"] = process.argv.slice(2);
assert.match(phase, /^phase\d+$/);
const root = path.resolve(rootArg), output = path.join(root, `rust-module-probe-${phase}`);
assert.ok(!fs.existsSync(output)); fs.mkdirSync(output);
const engine = path.join(root, `${phase}-corpus`, "engine-snapshot", "src");
const manifest = JSON.parse(fs.readFileSync(path.join(root, `${phase}-corpus`, "manifest.json")));
const { buildWorkspaceFlowGraph, clearFlowGraphCache } = await import(pathToFileURL(path.join(engine, "graph-builder.mjs")));
const compiler = spawnSync("rustc", ["--version"], { encoding: "utf8", windowsHide: true });
assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
const results = [];
for (const variant of ["control", "defect"]) {
  const workspace = path.join(output, variant);
  const bindings = variant === "control" ? "use facade::{expected as begin, nested::finish};" : "use wrong::other as begin;\nuse facade::nested::finish;";
  const sources = {
    "Cargo.toml": '[package]\nname="module-probe"\nversion="0.1.0"\nedition="2021"\n',
    "src/main.rs": `mod service;
mod facade;
mod wrong;
${bindings}
fn main() {
    assert_eq!(begin(), 7, "selected function must preserve the value");
    assert_eq!(finish(), 20);
}
`,
    "src/service.rs": `pub mod nested;\npub fn expected() -> i32 { 7 }\n`,
    "src/service/nested.rs": `pub fn finish() -> i32 { 20 }\n`,
    "src/facade/mod.rs": `pub use crate::service::{expected, nested};\n`,
    "src/wrong.rs": `pub fn other() -> i32 { 99 }\n`
  };
  for (const [file, source] of Object.entries(sources)) { fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true }); fs.writeFileSync(path.join(workspace, file), source); }
  const binary = path.join(workspace, process.platform === "win32" ? "probe.exe" : "probe");
  const compile = spawnSync("rustc", ["--edition=2021", path.join(workspace, "src/main.rs"), "-o", binary], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  fs.writeFileSync(path.join(workspace, "compile.json"), JSON.stringify({ exitCode: compile.status, stdout: compile.stdout, stderr: compile.stderr, error: compile.error?.message }, null, 2));
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(binary, [], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const graph = buildWorkspaceFlowGraph(workspace, true);
  const expected = graph.symbolsByName.get("expected")[0];
  const result = { variant, runtimeExitCode: run.status, runtimePassed: run.status === 0, stdout: run.stdout, stderr: run.stderr,
    targetRuntimeReachable: graph.reachableFromRuntimeSource.has(expected.id), inbound: graph.inEdgeDetails.get(expected.id) };
  results.push(result); clearFlowGraphCache();
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ sourceHash: manifest.engine.sourceHash, compiler: compiler.stdout.trim(),
    limitations: ["Synthetic compiler-backed fixture; not a real-project accuracy sample", "No claim about Tauri or Cargo dependency integration"], results }, null, 2));
  assert.equal(result.runtimePassed, variant === "control");
  assert.equal(result.targetRuntimeReachable, variant === "control");
  if (variant === "defect") assert.match(run.stderr, /selected function must preserve the value/);
}
console.log(JSON.stringify({ output, results: results.map(({ variant, runtimePassed, targetRuntimeReachable }) => ({ variant, runtimePassed, targetRuntimeReachable })) }));
