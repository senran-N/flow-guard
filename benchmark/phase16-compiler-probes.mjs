import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
const evidence = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const cohort = path.join(evidence, process.argv[2] || 'phase16-final3-validation');
const output = path.join(evidence, process.argv[3] || 'phase16-final3-compiler-probes');
assert.ok(!fs.existsSync(output)); fs.mkdirSync(output);
const manifest = JSON.parse(fs.readFileSync(path.join(cohort, 'manifest.json')));
const { buildWorkspaceFlowGraph, clearFlowGraphCache } = await import(pathToFileURL(path.join(cohort, 'engine-snapshot/src/graph-builder.mjs')));
const singleton = fs.readFileSync('D:/Myproject/crack/clash-verge-rev/src-tauri/src/utils/singleton.rs', 'utf8');
const prefix = `use std::sync::atomic::{AtomicUsize, Ordering};
static COUNT: AtomicUsize = AtomicUsize::new(0);
pub struct Worker;
impl Worker {
 pub fn new() -> Self { Worker {} }
 pub fn execute(&self) { COUNT.fetch_add(1, Ordering::SeqCst); }
}
`;
const examples = [
  { name: 'real-singleton-macro', target: 'execute', count: 1, code: prefix + singleton + '\nsingleton!(Worker, INSTANCE);\nfn main() { Worker::global().execute(); println!("{}", COUNT.load(Ordering::SeqCst)); }\n' },
  { name: 'generic-field-refcell', target: 'execute', count: 1, code: prefix + `use std::cell::RefCell as Cell;
struct Holder<T> { inner: Cell<T> }
fn main() {
 let holder: Holder<Worker> = Holder { inner: Cell::new(Worker {}) };
 holder.inner.borrow_mut().execute();
 println!("{}", COUNT.load(Ordering::SeqCst));
}
` },
  { name: 'generic-delegate', target: 'execute', count: 1, code: prefix + `struct Holder<T> { inner: T }
impl<T: Default> Holder<T> {
 fn new() -> Self { Self { inner: T::default() } }
 fn get(&self) -> &T { &self.inner }
}
impl Default for Worker {
 fn default() -> Self { Worker {} }
}
fn main() {
 Holder::<Worker>::new().get().execute();
 println!("{}", COUNT.load(Ordering::SeqCst));
}
` },
  { name: 'deleted-call', target: 'execute', count: 0, code: prefix + '\nfn main() { println!("{}", COUNT.load(Ordering::SeqCst)); }\n' },
  { name: 'direct-callback', target: 'event', count: 1, code: prefix + '\nfn invoke(cb: fn()) { cb(); }\npub fn event() { COUNT.fetch_add(1, Ordering::SeqCst); }\nfn main() { invoke(event); println!("{}", COUNT.load(Ordering::SeqCst)); }\n' },
  { name: 'stored-callback', target: 'event', count: 0, candidate: true, code: prefix + '\nfn register(_cb: fn()) {}\npub fn event() { COUNT.fetch_add(1, Ordering::SeqCst); }\nfn main() { register(event); println!("{}", COUNT.load(Ordering::SeqCst)); }\n' }
];
const results = [];
for (const item of examples) {
  const workspace = path.join(output, item.name); fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'Cargo.toml'), '[package]\nname="probe"\nversion="0.1.0"\n');
  const source = path.join(workspace, 'src/main.rs'), executable = path.join(workspace, 'probe.exe');
  fs.writeFileSync(source, item.code);
  execFileSync('rustc', ['--edition=2021', '-Awarnings', source, '-o', executable], { windowsHide: true, stdio: 'pipe' });
  const count = Number(execFileSync(executable, [], { encoding: 'utf8', windowsHide: true }).trim());
  assert.equal(count, item.count);
  const graph = buildWorkspaceFlowGraph(workspace, true), target = [...graph.symbolById.values()].find(s => s.name === item.target);
  assert.equal(graph.reachableFromRuntimeSource.has(target.id), count > 0, item.name);
  if (item.candidate) assert.ok(graph.possiblyReachableFromRuntimeSource.has(target.id));
  results.push({ name: item.name, runtimeCount: count, target: target.id, analyzerRuntimeReachable: graph.reachableFromRuntimeSource.has(target.id),
    candidate: graph.possiblyReachableFromRuntimeSource.has(target.id), sourceSha256: crypto.createHash('sha256').update(item.code).digest('hex') });
  clearFlowGraphCache();
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ sourceHash: manifest.engine.sourceHash,
  rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), results,
  limitation: 'Small compiler-backed controls, including exact upstream singleton macro; not full crate compilation or desktop runtime tests.' }, null, 2));
console.log(JSON.stringify({ sourceHash: manifest.engine.sourceHash, probesPassed: results.length }));
