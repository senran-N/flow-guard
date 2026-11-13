// Independent compiled controls plus exact evidence from the upstream Axum tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [engineArg, workspaceArg, outputArg, phase = 'phase12'] = process.argv.slice(2);
assert.ok(engineArg && workspaceArg && outputArg, 'Usage: rust-hardening-audit.mjs <engine> <axum> <new-output>');
const engine = path.resolve(engineArg), workspace = path.resolve(workspaceArg), output = path.resolve(outputArg);
assert.ok(!fs.existsSync(output), 'Do not overwrite evidence');
fs.mkdirSync(output, { recursive: true });
process.env.PLUGIN_DATA = path.join(output, 'state');
const { buildWorkspaceFlowGraph } = await import(pathToFileURL(path.join(engine, 'src/graph-builder.mjs')));
const { verifyWorkspaceFlow } = await import(pathToFileURL(path.join(engine, 'src/flow-verifier.mjs')));
const graph = buildWorkspaceFlowGraph(workspace, true);
const find = (file, name, container) => {
  const symbols = [...graph.symbolById.values()].filter((s) => s.file === file && s.name === name && (!container || s.parentContainerName === container));
  assert.equal(symbols.length, 1, `${file}:${container || ''}.${name}`);
  return symbols[0];
};
const checks = [];
const constructor = find('axum/src/handler/future.rs', 'new', 'LayeredFuture');
const handler = find('axum/src/handler/mod.rs', 'call', 'Layered');
const constructorEdge = graph.outEdgeDetails.get(handler.id).find((edge) => edge.toId === constructor.id);
assert.equal(constructorEdge.resolution.confidence, 'HIGH');
assert.equal(constructorEdge.evidence.line, 349);
checks.push({ name: 'LayeredFuture::new exact call', edge: constructorEdge });
const iterator = find('axum-macros/src/with_position.rs', 'new', 'WithPosition');
const iteratorEdges = graph.inEdgeDetails.get(iterator.id).filter((edge) => edge.evidence.file === 'axum-macros/src/debug_handler.rs');
assert.ok(iteratorEdges.length >= 3);
assert.ok(iteratorEdges.every((edge) => edge.resolution.confidence === 'HIGH'));
checks.push({ name: 'WithPosition::new exact calls', edges: iteratorEdges });
const callback = find('axum-macros/src/from_ref.rs', 'expand');
const entry = find('axum-macros/src/lib.rs', 'derive_from_ref');
const callbackEdge = graph.outEdgeDetails.get(entry.id).find((edge) => edge.toId === callback.id);
assert.equal(callbackEdge.resolution.mode, 'RUST_CALLBACK_REFERENCE');
assert.equal(callbackEdge.resolution.confidence, 'MEDIUM');
assert.ok(!graph.reachableFromRuntimeSource.has(callback.id));
checks.push({ name: 'FromRef callback remains candidate', edge: callbackEdge });
for (const name of ['has_routes', 'call_with_state']) {
  const target = find('axum/src/routing/path_router.rs', name, 'PathRouter');
  assert.ok(target.rustReceiverCandidates.some((candidate) => candidate.file === 'axum/src/routing/mod.rs'));
  checks.push({ name: `${name} field receiver uncertainty`, candidates: target.rustReceiverCandidates });
}
const rejection = find('axum-core/src/extract/rejection.rs', 'from_err', 'FailedToBufferBody');
const rejectionEdges = graph.inEdgeDetails.get(rejection.id).filter((edge) => edge.evidence.file === 'axum-core/src/extract/request_parts.rs');
assert.equal(rejectionEdges.length, 2);
assert.ok(rejectionEdges.every((edge) => edge.resolution.mode === 'RUST_CALLBACK_REFERENCE'));
checks.push({ name: 'FailedToBufferBody callback paths', edges: rejectionEdges });
const report = verifyWorkspaceFlow(workspace, { fullScan: true, ignoreSavedPlan: true });
assert.equal(report.verificationVerdict, 'INCONCLUSIVE');
assert.equal(report.summary.obligationsViolated, 0);
if (phase === 'phase13') {
  const module = graph.files.find((file) => file.file === 'axum-macros/src/axum_test.rs');
  assert.equal(module.zone, 'prod');
  assert.equal(find(module.file, 'expand').zone, 'prod');
  assert.ok(!report.sandboxCandidates.some((item) => /axum_test.rs/.test(item.illegalTarget)));
  checks.push({ name: 'Cargo module membership classifies axum_test as production source', file: module.file, zone: module.zone });
} else assert.ok(report.sandboxCandidates.some((item) => /axum_test.rs/.test(item.illegalTarget)));

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return { exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};
const rustVersion = run('rustc', ['--version']).stdout;
const fixtures = {
  constructor: `struct Worker(u8);\nimpl Worker { fn new() -> Self { Self(7) } }\nstruct Other(u8);\nimpl Other { fn new() -> Self { Self(99) } }\nfn main() { assert_eq!(Worker::new().0, 7); assert_eq!(Other::new().0, 99); }\n`,
  callback: `use std::sync::atomic::{AtomicUsize, Ordering};\nstatic COUNT: AtomicUsize = AtomicUsize::new(0);\nmod api { pub fn expand() { super::COUNT.fetch_add(1, super::Ordering::SeqCst); } }\nfn register_only(_: fn()) {}\nfn execute(f: fn()) { f(); }\nfn main() { register_only(api::expand); assert_eq!(COUNT.load(Ordering::SeqCst), 0); execute(api::expand); assert_eq!(COUNT.load(Ordering::SeqCst), 1); }\n`,
  field: `struct Worker;\nimpl Worker { fn execute(&self) -> u8 { 7 } }\nstruct Inner { worker: Worker }\nstruct Outer { inner: Inner }\nimpl Outer { fn execute(&self) -> u8 { self.inner.worker.execute() } }\nfn main() { let outer = Outer { inner: Inner { worker: Worker } }; assert_eq!(outer.execute(), 7); }\n`
};
if (phase === 'phase13') {
  fs.writeFileSync(path.join(output, 'ordinary_test.rs'), 'pub fn run() -> u8 { 7 }\n#[test]\nfn test_only() { compile_error!("test function must not compile in a normal build"); }\n');
  fs.writeFileSync(path.join(output, 'only_tests.rs'), 'compile_error!("test module must not compile in a normal build");\n');
  fixtures.module_suffix = '#[path = "ordinary_test.rs"]\nmod ordinary;\nfn main() { assert_eq!(ordinary::run(), 7); }\n';
  fixtures.test_module = '#[cfg(test)]\n#[path = "only_tests.rs"]\nmod hidden;\nfn main() {}\n';
}
const compiledControls = [];
for (const [name, source] of Object.entries(fixtures)) {
  const file = path.join(output, `${name}.rs`), binary = path.join(output, name + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(file, source);
  const compilation = run('rustc', ['--edition=2021', '--crate-name', `flowguard_${name}`, file, '-o', binary]);
  compiledControls.push({ name, source, compilation, execution: run(binary, []) });
}
const sourceFiles = Object.fromEntries(fs.readdirSync(path.join(engine, 'src')).filter((file) => file.endsWith('.mjs')).sort()
  .map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(engine, 'src', file))).digest('hex')]));
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ sourceHash: crypto.createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
  checks, rustVersion, compiledControls, verdict: report.verificationVerdict, remainingSandboxCandidates: report.sandboxCandidates }, null, 2));
console.log(JSON.stringify({ checks: checks.length, compiledControls: compiledControls.length, rustVersion, verdict: report.verificationVerdict }));
