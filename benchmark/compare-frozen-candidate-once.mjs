// Run one frozen-baseline/candidate pair without copying live workspace code.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const [evidenceRootArg, workspaceArg, candidateArg, outputName] = process.argv.slice(2);
assert.ok(evidenceRootArg && workspaceArg && candidateArg && outputName, "Usage: node benchmark/compare-frozen-candidate-once.mjs <evidence-root> <workspace> <candidate-engine> <output-name>");
const evidenceRoot = path.resolve(evidenceRootArg), workspace = path.resolve(workspaceArg), candidate = path.resolve(candidateArg);
const output = path.resolve(evidenceRoot, outputName), frozen = path.join(evidenceRoot, "phase9-corpus", "engine-snapshot");
assert.equal(path.dirname(output), evidenceRoot, "output must be directly inside the evidence root");
assert.ok(!fs.existsSync(output), "performance evidence must not be overwritten");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashes = (root) => Object.fromEntries(fs.readdirSync(path.join(root, "src")).sort().map((file) => [file, sha256(fs.readFileSync(path.join(root, "src", file)))]));
const manifest = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "phase9-corpus", "manifest.json"), "utf8"));
assert.deepEqual(hashes(frozen), manifest.engine.files, "frozen phase9 source differs from manifest");
for (const [file, digest] of Object.entries(hashes(frozen))) {
  if (file !== "graph-builder.mjs") assert.equal(hashes(candidate)[file], digest, `candidate differs outside graph-builder.mjs: ${file}`);
}
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const initialCommit = git("rev-parse", "HEAD"), initialStatus = git("status", "--porcelain");
const engines = {
  phase9: path.join(frozen, "benchmark", "real-world-worker.mjs"),
  candidate: path.join(candidate, "benchmark", "real-world-worker.mjs")
};
const result = { startedAt: new Date().toISOString(), workspace, initialCommit, initialStatus, timeoutMs: 120000,
  phase9SourceHash: manifest.engine.sourceHash, candidateSourceHash: sha256(JSON.stringify(hashes(candidate))), runs: [] };
fs.mkdirSync(output);
const persist = () => fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
persist();
for (const phase of ["phase9", "candidate"]) {
  const destination = path.join(output, `${phase}.json`), start = Date.now();
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [engines[phase], workspace, destination], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLUGIN_DATA: path.join(output, "state", phase) } });
    let stderr = "", timedOut = false;
    child.stdout.resume(); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill("SIGKILL"); } }, result.timeoutMs);
    child.on("close", (exitCode, signal) => { clearTimeout(timer); const scan = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, "utf8")) : null;
      resolve({ phase, exitCode, signal, timedOut, elapsedMs: Date.now() - start, stderr, destination, verifyMs: scan?.verifyMs, rssMiB: scan?.rssMiB,
        resultHash: scan?.report ? sha256(JSON.stringify({ graph: scan.graph, report: scan.report })) : null }); });
  });
  result.runs.push(run); persist(); console.log(JSON.stringify(run));
}
result.finalCommit = git("rev-parse", "HEAD"); result.finalStatus = git("status", "--porcelain");
result.completed = result.runs.every((run) => run.exitCode === 0 && !run.timedOut && run.resultHash);
result.identicalReports = result.completed && result.runs[0].resultHash === result.runs[1].resultHash;
result.finishedAt = new Date().toISOString(); persist();
assert.equal(result.finalCommit, initialCommit); assert.equal(result.finalStatus, initialStatus);
if (result.completed) assert.ok(result.identicalReports, "candidate changed the complete report");
