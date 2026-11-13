// Compare the frozen phase9 engine with the current candidate on one workspace.
// Runs are deliberately serial and retain the corpus's 120-second limit.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const [evidenceRootArg, workspaceArg, outputName = "performance-argument-sites"] = process.argv.slice(2);
assert.ok(evidenceRootArg && workspaceArg, "Usage: node benchmark/compare-phase9-argument-sites.mjs <evidence-root> <workspace> [output-name]");
const evidenceRoot = path.resolve(evidenceRootArg);
const workspace = path.resolve(workspaceArg);
const output = path.resolve(evidenceRoot, outputName);
assert.equal(path.dirname(output), evidenceRoot, "output must be directly inside the evidence root");
assert.ok(!fs.existsSync(output), "performance evidence must not be overwritten");

const frozen = path.join(evidenceRoot, "phase9-corpus", "engine-snapshot");
const sourceRoot = path.resolve(".");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sourceFileHashes = (root) => Object.fromEntries(fs.readdirSync(path.join(root, "src")).sort()
  .map((file) => [file, sha256(fs.readFileSync(path.join(root, "src", file)))]));
const sourceHash = (root) => sha256(JSON.stringify(sourceFileHashes(root)));
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const initialCommit = git("rev-parse", "HEAD");
const initialStatus = git("status", "--porcelain");

fs.mkdirSync(output);
const candidate = path.join(output, "candidate-engine");
fs.mkdirSync(candidate);
// The candidate snapshot must differ from phase9 only in this performance
// hunk.  In particular, do not pull concurrent verifier/server work into the
// A/B comparison.
const frozenSrc = path.join(frozen, "src");
const currentSrc = path.join(sourceRoot, "src");
const manifest = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "phase9-corpus", "manifest.json"), "utf8"));
assert.deepEqual(sourceFileHashes(frozen), manifest.engine.files, "phase9 frozen source files differ from their manifest");
assert.equal(sourceHash(frozen), manifest.engine.sourceHash, "phase9 frozen source hash differs from its manifest");
fs.cpSync(frozenSrc, path.join(candidate, "src"), { recursive: true });
fs.copyFileSync(path.join(currentSrc, "graph-builder.mjs"), path.join(candidate, "src", "graph-builder.mjs"));
for (const file of fs.readdirSync(frozenSrc)) {
  if (file === "graph-builder.mjs") continue;
  assert.equal(
    sha256(fs.readFileSync(path.join(candidate, "src", file))),
    sha256(fs.readFileSync(path.join(frozenSrc, file))),
    `candidate unexpectedly differs outside graph-builder.mjs: ${file}`
  );
}
fs.mkdirSync(path.join(candidate, "benchmark"));
fs.copyFileSync(path.join(frozen, "benchmark", "real-world-worker.mjs"), path.join(candidate, "benchmark", "real-world-worker.mjs"));

const engines = {
  phase9: { root: frozen, worker: path.join(frozen, "benchmark", "real-world-worker.mjs"), sourceHash: sourceHash(frozen) },
  candidate: { root: candidate, worker: path.join(candidate, "benchmark", "real-world-worker.mjs"), sourceHash: sourceHash(candidate) }
};
const result = {
  startedAt: new Date().toISOString(), workspace, initialCommit, initialStatus,
  timeoutMs: 120000, order: ["phase9", "candidate", "candidate", "phase9"], engines, runs: [],
  limitations: ["same-machine serial measurement", "final RSS is not peak RSS"]
};
const persist = () => fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
persist();
for (const [index, phase] of result.order.entries()) {
  const destination = path.join(output, `${index + 1}-${phase}.json`);
  const start = Date.now();
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [engines[phase].worker, workspace, destination], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLUGIN_DATA: path.join(output, "state", String(index)) }
    });
    let stderr = "", timedOut = false;
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
      catch { child.kill("SIGKILL"); }
    }, result.timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const scan = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, "utf8")) : null;
      resolve({ phase, exitCode, signal, timedOut, elapsedMs: Date.now() - start, stderr, destination,
        verifyMs: scan?.verifyMs, rssMiB: scan?.rssMiB,
        resultHash: scan?.report ? sha256(JSON.stringify({ graph: scan.graph, report: scan.report })) : null });
    });
  });
  result.runs.push(run); persist(); console.log(JSON.stringify(run));
}
result.finalCommit = git("rev-parse", "HEAD");
result.finalStatus = git("status", "--porcelain");
result.completed = result.runs.every((run) => run.exitCode === 0 && !run.timedOut && run.resultHash);
result.identicalReports = result.completed && result.runs.every((run) => run.resultHash === result.runs[0].resultHash);
result.finishedAt = new Date().toISOString();
persist();
assert.equal(result.finalCommit, initialCommit, "benchmark must not modify the corpus workspace");
assert.equal(result.finalStatus, initialStatus, "benchmark must not modify the corpus workspace");
if (result.completed) assert.ok(result.identicalReports, "candidate changed the complete report");
