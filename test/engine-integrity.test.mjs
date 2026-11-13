import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateFlowOverview, generateWiringBlueprint, traceSymbolFlow } from "../src/flow-tools.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { clearActiveWiringPlan } from "../src/wiring-contract.mjs";
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from "../src/graph-builder.mjs";
import { getScopedStatePath, readScopedState, writeScopedState } from "../src/state-store.mjs";
import { resolveRoot } from "../src/server.mjs";
import { runHook } from "../src/hook-runner.mjs";

const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const scopeA = { sessionId: "session-A", taskId: "task-1" };
const scopeB = { sessionId: "session-B", taskId: "task-1" };

function write(dir, relative, content) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function withWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard integrity-"));
  const oldData = process.env.PLUGIN_DATA;
  const oldSession = process.env.FLOWGUARD_SESSION_ID;
  const oldTask = process.env.FLOWGUARD_TASK_ID;
  process.env.PLUGIN_DATA = path.join(dir, ".state");
  delete process.env.FLOWGUARD_SESSION_ID;
  delete process.env.FLOWGUARD_TASK_ID;
  try {
    write(dir, "package.json", JSON.stringify({ name: "integrity-app", private: true, type: "module" }));
    write(dir, ".gitignore", ".state/\n");
    write(dir, "src/worker.mjs", `export class Worker {
  constructor() {
    this.ready = true;
  }
  run() {
    console.log(this.ready);
  }
  missingFeature(value) {
    return value * 2;
  }
}`);
    write(dir, "src/main.mjs", `import { Worker } from './worker.mjs';
export function main() {
  const worker = new Worker();
  worker.run();
}
main();`);
    return fn(dir);
  } finally {
    for (const [key, old] of [["PLUGIN_DATA", oldData], ["FLOWGUARD_SESSION_ID", oldSession], ["FLOWGUARD_TASK_ID", oldTask]]) {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("flowguard integrity-"));
    fs.rmSync(dir, { recursive: true, force: true });
    clearFlowGraphCache();
  }
}

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(dir) {
  git(dir, "init");
  git(dir, "config", "user.name", "FlowGuard Test");
  git(dir, "config", "user.email", "test@flowguard.local");
  git(dir, "add", ".");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-m", "baseline");
  return git(dir, "rev-parse", "HEAD");
}

function plan(dir, targetSymbol, scope = scopeA) {
  return generateWiringBlueprint(dir, "Worker", { ...scope, targetSymbol, requirePersistence: "not_required" }).wiringPlan;
}

function entry(report) {
  return report.wiringReport.obligations.find((o) => o.checkSpec?.type === "ENTRY_REACHABILITY");
}

function cli(dir, ...args) {
  return spawnSync(process.execPath, [server, "--cli", ...args], { cwd: dir, encoding: "utf8", env: process.env });
}

test("class membership does not make an uncalled method runtime reachable", () => withWorkspace((dir) => {
  const missing = traceSymbolFlow(dir, "missingFeature").traces[0];
  assert.equal(missing.waterFlowStatus.connectedToRuntimeEntry, false);
  assert.equal(traceSymbolFlow(dir, "run").traces.find((t) => t.symbol.includes("run")).waterFlowStatus.connectedToRuntimeEntry, true);
  assert.ok(missing.evidencedRelations.inbound.some((edge) => edge.kind === "CONTAINS"));
  assert.equal(traceSymbolFlow(dir, "constructor").traces[0].waterFlowStatus.connectedToRuntimeEntry, true);
  plan(dir, "Worker.missingFeature");
  assert.equal(entry(verifyWorkspaceFlow(dir, { ...scopeA, fullScan: true })).status, "VIOLATED");
}));

test("unchanged graph reuse is content-based even after a long verification", () => withWorkspace((dir) => {
  const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
  const realNow = performance.now.bind(performance);
  const graph = buildWorkspaceFlowGraph(dir, true);
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => realNow() + 120000 });
    assert.equal(buildWorkspaceFlowGraph(dir), graph);
  } finally {
    if (originalNow) Object.defineProperty(performance, "now", originalNow); else delete performance.now;
  }
}));

test("manifest edits invalidate cached package modes even with preserved size and mtime", () => withWorkspace((dir) => {
  const file = path.join(dir, "package.json");
  const app = JSON.stringify({ name: "boundary", private: true }).padEnd(128);
  const library = JSON.stringify({ name: "boundary", exports: "./src/worker.mjs" }).padEnd(128);
  fs.writeFileSync(file, app);
  const initial = buildWorkspaceFlowGraph(dir, true), stamp = fs.statSync(file);
  assert.equal(initial.workspaceProfile.projectMode, "application");
  fs.writeFileSync(file, library); fs.utimesSync(file, stamp.atime, stamp.mtime);
  const updated = buildWorkspaceFlowGraph(dir);
  assert.notEqual(updated, initial);
  assert.equal(updated.workspaceProfile.projectMode, "library");
}));

test("cache detects new and removed files with directory timestamps restored", () => withWorkspace((dir) => {
  const sourceDir = path.join(dir, "src");
  let initial = buildWorkspaceFlowGraph(dir, true), stamp = fs.statSync(sourceDir);
  write(dir, "src/added.mjs", "export function added(value) { return value; }\n");
  fs.utimesSync(sourceDir, stamp.atime, stamp.mtime);
  let updated = buildWorkspaceFlowGraph(dir);
  assert.notEqual(updated, initial); assert.ok(updated.symbolsByName.has("added"));
  initial = updated; stamp = fs.statSync(sourceDir);
  fs.unlinkSync(path.join(sourceDir, "added.mjs")); fs.utimesSync(sourceDir, stamp.atime, stamp.mtime);
  updated = buildWorkspaceFlowGraph(dir);
  assert.notEqual(updated, initial); assert.ok(!updated.symbolsByName.has("added"));
}));

test("a caller without a runtime entry cannot satisfy entry wiring", () => withWorkspace((dir) => {
  write(dir, "src/helpers.mjs", `export function isolatedCaller() {
  return target(3);
}
export function target(value) {
  return value * 2;
}`);
  plan(dir, "target");
  assert.equal(entry(verifyWorkspaceFlow(dir, { ...scopeA, fullScan: true })).status, "VIOLATED");
}));

test("ambiguous calls remain possible paths instead of confirmed runtime reachability", () => withWorkspace((dir) => {
  write(dir, "src/ambiguous.ts", `class Alpha {
  execute(value: number) { return value + 1; }
}
class Beta {
  execute(value: number) { return value + 2; }
}
export function main(worker: Alpha | Beta) {
  console.log(worker.execute(3));
}`);
  const traces = traceSymbolFlow(dir, "execute").traces;
  assert.ok(traces.length >= 2);
  assert.ok(traces.every((t) => !t.waterFlowStatus.connectedToRuntimeEntry));
  assert.ok(traces.some((t) => t.waterFlowStatus.possiblyConnectedToRuntimeEntry));
}));

test("an invalid explicit Git baseline fails in API and CLI without fallback", () => withWorkspace((dir) => {
  initGit(dir);
  assert.throws(() => verifyWorkspaceFlow(dir, { baseRef: "missing-review-ref" }), /requested Git baseline/);
  const result = cli(dir, "verify", dir, "--base", "missing-review-ref");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing-review-ref/);
}));

test("valid explicit baselines report the exact resolved commit", () => withWorkspace((dir) => {
  const commit = initGit(dir);
  const report = verifyWorkspaceFlow(dir, { baseRef: "HEAD" });
  assert.equal(report.baseline.commit, commit);
  assert.equal(report.baseline.requestedRef, "HEAD");
  assert.equal(report.flowDiff.baseCommit, commit);
}));

test("non-Git same-size edits with preserved mtime produce a content-based delta", () => withWorkspace((dir) => {
  generateFlowOverview(dir, false, { ...scopeA, saveBaseline: true });
  const file = path.join(dir, "src/worker.mjs");
  const before = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("value * 2", "value * 3"));
  fs.utimesSync(file, before.atime, before.mtime);
  const report = verifyWorkspaceFlow(dir, scopeA);
  assert.equal(report.scanMode, "INCREMENTAL_SESSION_DIFF");
  assert.deepEqual(report.changedFilesScanned, ["src/worker.mjs"]);
  assert.ok(report.flowDiff);
  assert.equal(report.baseline.source, "SESSION_SNAPSHOT");
  generateFlowOverview(dir, false, { ...scopeB, saveBaseline: true });
  assert.deepEqual(verifyWorkspaceFlow(dir, scopeB).changedFilesScanned, []);
}));

test("session snapshots track additions and deletions and preserve a clean delta", () => withWorkspace((dir) => {
  generateFlowOverview(dir, false, { ...scopeA, saveBaseline: true });
  const unchanged = verifyWorkspaceFlow(dir, scopeA);
  assert.ok(unchanged.flowDiff);
  assert.deepEqual(unchanged.flowDiff.changedSourceFiles, []);
  fs.unlinkSync(path.join(dir, "src/worker.mjs"));
  write(dir, "src/new.mjs", "export function nextFeature() {\n  return 4;\n}\n");
  const report = verifyWorkspaceFlow(dir, scopeA);
  assert.ok(report.flowDiff.deletedSourceFiles.includes("src/worker.mjs"));
  assert.ok(report.changedFilesScanned.includes("src/new.mjs"));
}));

test("session snapshots exclude dirty changes already present at task start", () => withWorkspace((dir) => {
  initGit(dir);
  write(dir, "src/old.mjs", "export function oldDraft() {\n  return 2;\n}\n");
  generateFlowOverview(dir, false, { ...scopeA, saveBaseline: true });
  write(dir, "src/new.mjs", "export function newDraft() {\n  return 3;\n}\n");
  const report = verifyWorkspaceFlow(dir, scopeA);
  assert.deepEqual(report.changedFilesScanned, ["src/new.mjs"]);
}));

test("blueprints and baselines are isolated by session and task", () => withWorkspace((dir) => {
  const a = plan(dir, "Worker.missingFeature", scopeA);
  const b = plan(dir, "Worker.run", scopeB);
  const task2 = { ...scopeA, taskId: "task-2" };
  const c = plan(dir, "Worker.run", task2);
  assert.notEqual(a.planId, b.planId);
  assert.notEqual(a.planId, c.planId);
  generateFlowOverview(dir, false, { ...scopeA, saveBaseline: true });
  write(dir, "src/new.mjs", "export function newFeature() {\n  return 5;\n}\n");
  generateFlowOverview(dir, false, { ...scopeB, saveBaseline: true });
  const ra = verifyWorkspaceFlow(dir, scopeA);
  const rb = verifyWorkspaceFlow(dir, scopeB);
  assert.equal(ra.wiringReport.planId, a.planId);
  assert.equal(rb.wiringReport.planId, b.planId);
  assert.equal(verifyWorkspaceFlow(dir, task2).wiringReport.planId, c.planId);
  assert.ok(ra.changedFilesScanned.includes("src/new.mjs"));
  assert.deepEqual(rb.changedFilesScanned, []);
  clearActiveWiringPlan(dir, scopeA);
  assert.equal(verifyWorkspaceFlow(dir, scopeB).wiringReport.planId, b.planId);
  assert.throws(() => verifyWorkspaceFlow(dir, { ...scopeB, wiringPlan: a }), /does not match/);
}));

test("expired, corrupt and mismatched state is diagnosed rather than reused", () => withWorkspace((dir) => {
  plan(dir, "Worker.run");
  const file = getScopedStatePath("plan", dir, scopeA);
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  envelope.createdAt = "2000-01-01T00:00:00Z";
  fs.writeFileSync(file, JSON.stringify(envelope));
  let report = verifyWorkspaceFlow(dir, scopeA);
  assert.ok(report.stateDiagnostics.some((d) => /expired/.test(d.reason)));
  assert.equal(report.wiringReport.planId, null);
  assert.equal(report.wiringReport.obligations.find((o) => o.id === "STATE-VALIDITY").status, "INCONCLUSIVE");
  fs.writeFileSync(file, "{incomplete");
  assert.ok(verifyWorkspaceFlow(dir, scopeA).stateDiagnostics.length > 0);
  envelope.createdAt = new Date().toISOString();
  envelope.scope.workspaceRoot = path.join(dir, "other");
  fs.writeFileSync(file, JSON.stringify(envelope));
  report = verifyWorkspaceFlow(dir, scopeA);
  assert.ok(report.stateDiagnostics.some((d) => /mismatch/.test(d.reason)));
}));

test("branch switches invalidate saved task state", () => withWorkspace((dir) => {
  initGit(dir);
  plan(dir, "Worker.run");
  generateFlowOverview(dir, false, { ...scopeA, saveBaseline: true });
  git(dir, "checkout", "-b", "other-task");
  const report = verifyWorkspaceFlow(dir, scopeA);
  assert.ok(report.stateDiagnostics.some((d) => d.kind === "plan" && /branch/.test(d.reason)));
  assert.ok(report.stateDiagnostics.some((d) => d.kind === "baseline" && /branch/.test(d.reason)));
}));

test("state publication is atomic and untrusted IDs stay inside the data directory", () => withWorkspace((dir) => {
  const scope = { sessionId: "../../outside", taskId: "x/y" };
  const file = writeScopedState("plan", dir, { version: 1 }, scope);
  assert.equal(path.dirname(file), process.env.PLUGIN_DATA);
  fs.writeFileSync(`${file}.partial.tmp`, "{incomplete");
  assert.equal(readScopedState("plan", dir, scope).version, 1);
  writeScopedState("plan", dir, { version: 2 }, scope);
  assert.equal(readScopedState("plan", dir, scope).version, 2);
  assert.deepEqual(fs.readdirSync(process.env.PLUGIN_DATA).filter((name) => name.endsWith(".tmp")), [path.basename(`${file}.partial.tmp`)]);
}));

test("MCP workspace resolution never falls back to another workspace's shared cache", () => withWorkspace((dir) => {
  fs.mkdirSync(process.env.PLUGIN_DATA, { recursive: true });
  fs.writeFileSync(path.join(process.env.PLUGIN_DATA, "flowguard-last-workspace.txt"), dir);
  assert.equal(resolveRoot(), process.cwd());
  assert.throws(() => resolveRoot(path.join(dir, "missing")), /Invalid workspaceRoot/);
  runHook("session-start", { workspacePaths: [dir], conversationId: scopeA.sessionId, taskId: scopeA.taskId });
  assert.ok(fs.existsSync(getScopedStatePath("baseline", dir, scopeA)));
}));

test("unreferenced private code carries uncertainty and no automatic deletion verdict", () => withWorkspace((dir) => {
  write(dir, "src/private.mjs", "function privateUnused(value) {\n  return value + 1;\n}\n");
  const report = verifyWorkspaceFlow(dir, { fullScan: true });
  const finding = report.unwiredOrDeadPipes.find((item) => item.symbol.includes("privateUnused"));
  assert.ok(finding);
  assert.equal(finding.evidenceStrength, "NO_STATIC_CALLER_EVIDENCE");
  assert.equal(finding.verdict, "REVIEW_BEFORE_DELETE_OR_WIRE");
  assert.ok(finding.analysisScope.sourceFiles > 0);
  assert.ok(finding.uncertainty.length > 0);
}));

function behavior(dir, script, options = {}) {
  write(dir, "test/probe.mjs", script);
  const report = verifyWorkspaceFlow(dir, { ...scopeA, fullScan: true,
    runTestsCommand: `"${process.execPath}" test/probe.mjs`, ...options });
  return { report, result: report.wiringReport.obligations.find((o) => o.layer === "L3_BEHAVIORAL") };
}

test("test runs preserve stdout, stderr, exit status and a durable artifact", () => withWorkspace((dir) => {
  const { result } = behavior(dir, "console.log('probe evidence'); console.error('diagnostic');");
  assert.equal(result.status, "SATISFIED");
  assert.equal(result.execution.outcome, "PASSED");
  assert.match(result.execution.stdout, /probe evidence/);
  assert.match(result.execution.stderr, /diagnostic/);
  assert.equal(JSON.parse(fs.readFileSync(result.execution.artifactPath, "utf8")).value.exitCode, 0);
}));

test("failed assertions remain violations", () => withWorkspace((dir) => {
  const { report, result } = behavior(dir, "import assert from 'node:assert/strict'; assert.equal(1, 2);");
  assert.equal(result.status, "VIOLATED");
  assert.equal(result.execution.outcome, "TEST_FAILED");
  assert.deepEqual(report.executionErrors, []);
}));

test("missing commands are execution errors, not behavioral violations", () => withWorkspace((dir) => {
  const { report, result } = behavior(dir, "", { runTestsCommand: "flowguard_missing_executable_73291" });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.execution.outcome, "EXECUTION_ERROR");
  assert.equal(report.status, "EXECUTION_ERROR");
  const response = cli(dir, "verify", dir, "--run-tests", "flowguard_missing_executable_73291");
  assert.equal(response.status, 2);
}));

test("timeouts remain inconclusive with a distinct outcome", () => withWorkspace((dir) => {
  const { report, result } = behavior(dir, "setTimeout(() => {}, 10000);", { testTimeoutMs: 100 });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.execution.outcome, "TIMED_OUT");
  assert.equal(report.executionErrors.length, 1);
}));

test("output limits are execution errors and do not masquerade as assertion failures", () => withWorkspace((dir) => {
  const { result } = behavior(dir, "process.stdout.write('x'.repeat(2 * 1024 * 1024));");
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.execution.outcome, "OUTPUT_LIMIT");
}));

test("CLI forwards session/task isolation to persisted blueprints", () => withWorkspace((dir) => {
  const response = cli(dir, "blueprint", dir, "Worker", "--target", "Worker.run", "--session", "cli-session", "--task", "cli-task");
  assert.equal(response.status, 0, response.stderr);
  const check = cli(dir, "verify", dir, "--session", "cli-session", "--task", "cli-task");
  const report = JSON.parse(check.stdout);
  assert.equal(report.wiringReport.planId, JSON.parse(response.stdout).wiringPlan.planId);
  assert.equal(report.stateScope.sessionId, "cli-session");
  assert.equal(report.stateScope.taskId, "cli-task");
}));
