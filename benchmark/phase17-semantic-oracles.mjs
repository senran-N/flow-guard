// Local proc-macro crate: real Cargo execution versus analyzer evidence.
// Usage: node benchmark/phase17-semantic-oracles.mjs <engine-directory> <new-output>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [engineArg = '.', outputArg] = process.argv.slice(2);
assert.ok(outputArg, 'Supply engine directory and new evidence directory');
const engine = path.resolve(engineArg), output = path.resolve(outputArg);
assert.ok(!fs.existsSync(output));
fs.mkdirSync(path.join(output, 'src'), { recursive: true });
fs.mkdirSync(path.join(output, 'macros/src'), { recursive: true });
fs.writeFileSync(path.join(output, 'Cargo.toml'), '[package]\nname="semantic_cases"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nprobe_macros={path="macros"}\n[features]\nextra=[]\n');
fs.writeFileSync(path.join(output, 'macros/Cargo.toml'), '[package]\nname="probe_macros"\nversion="0.1.0"\nedition="2021"\n[lib]\nproc-macro=true\n');
fs.writeFileSync(path.join(output, 'macros/src/lib.rs'), `use proc_macro::TokenStream;
#[proc_macro]
pub fn run_worker(_: TokenStream) -> TokenStream { "Worker::execute(&Worker);".parse().unwrap() }
#[proc_macro]
pub fn make_factory(_: TokenStream) -> TokenStream { "fn generated() -> Worker { Worker }".parse().unwrap() }
`);
fs.writeFileSync(path.join(output, 'src/main.rs'), `use probe_macros::{run_worker, make_factory};
make_factory!();
struct Worker;
impl Worker {
 fn execute(&self) { println!("execute"); }
}
type Alias<T> = Box<T>;
trait Job { fn perform(&self); }
impl Job for Worker {
 fn perform(&self) { println!("perform"); }
}
fn dynamic(worker: &dyn Job) { worker.perform(); }
#[cfg(feature="extra")]
fn enabled() { println!("extra"); }
#[cfg(not(feature="extra"))]
fn enabled() { println!("default"); }
fn main() {
 let worker: Alias<Worker> = Box::new(Worker);
 worker.execute();
 run_worker!();
 generated().execute();
 enabled();
 dynamic(&Worker);
}
`);
execFileSync('cargo', ['generate-lockfile', '--offline'], { cwd: output, windowsHide: true });
const { buildWorkspaceFlowGraph } = await import(pathToFileURL(path.join(engine, 'src/graph-builder.mjs')));
const results = [];
for (const features of ['', 'extra']) {
  const graph = buildWorkspaceFlowGraph(output, true, { rustSemantic: true, rustBuildScripts: true, rustFeatures: features });
  const report = graph.rustSemantics;
  assert.equal(report.outcome, 'COMPLETED');
  const main = report.results.find(value => value.items?.some(item => item.name === 'main'));
  const calls = report.mappedEdges.filter(edge => edge.fromId === main.id);
  assert.equal(calls.filter(edge => graph.symbolById.get(edge.toId).name === 'execute').length, 2);
  const selected = calls.filter(edge => graph.symbolById.get(edge.toId).name === 'enabled');
  assert.equal(selected.length, 1);
  assert.equal(graph.symbolById.get(selected[0].toId).startLine, features ? 14 : 16);
  const trait = report.mappedEdges.filter(edge => edge.resolution.mode === 'RUST_COMPILER_TRAIT_CANDIDATE');
  assert.equal(trait.length, 1);
  assert.ok(!graph.reachableFromRuntimeSource.has(trait[0].toId));
  assert.ok(graph.possiblyReachableFromRuntimeSource.has(trait[0].toId));
  assert.match(report.expansions.find(value => value.name === 'run_worker').expansion.expansion, /Worker::execute/);
  assert.match(report.expansions.find(value => value.name === 'make_factory').expansion.expansion, /fn generated/);
  const stdout = execFileSync('cargo', ['run', '--quiet', '--offline', ...(features ? ['--features', features] : [])], { cwd: output, encoding: 'utf8', windowsHide: true });
  assert.equal(stdout.trim(), `execute\nexecute\nexecute\n${features || 'default'}\nperform`);
  const name = features || 'default';
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(report, null, 2));
  results.push({ features: name, outcome: 'PASSED', mappedExecuteSites: 2, runtimeExecuteCount: 3, traitCandidates: 1, stdout,
    limitation: 'The macro-internal call is visible in the expansion preview, not a source-mapped call edge; dyn dispatch remains a candidate.' });
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
