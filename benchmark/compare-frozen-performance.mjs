// Run A/B/B/A in separate processes, comparing complete graph/report hashes.
// This is a same-machine measurement; it is not a cross-platform latency claim.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

const [rootArg, workspaceArg, before = "phase7", after = "phase8", name = "performance-phase8"] = process.argv.slice(2);
assert.ok(rootArg && workspaceArg, "Usage: compare-frozen-performance.mjs <evidence-root> <repository> [before] [after] [new-output-name]");
assert.match(before, /^phase\d+$/); assert.match(after, /^phase\d+$/);
const root = path.resolve(rootArg), workspace = path.resolve(workspaceArg), output = path.resolve(root, name);
assert.equal(path.dirname(output), root);
assert.ok(!fs.existsSync(output), "Existing evidence must not be overwritten");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const commit = git("rev-parse", "HEAD"), initialStatus = git("status", "--porcelain");
const engines = Object.fromEntries([before, after].map((phase) => {
  const directory = path.join(root, `${phase}-corpus`), manifest = read(path.join(directory, "manifest.json"));
  const snapshot = path.join(directory, "engine-snapshot");
  for (const [file, expected] of Object.entries(manifest.engine.files)) assert.equal(hash(fs.readFileSync(path.join(snapshot, "src", file))), expected);
  assert.equal(manifest.repositories.find((repo) => repo.workspace === workspace)?.commit, commit);
  return [phase, { sourceHash: manifest.engine.sourceHash, worker: path.join(snapshot, "benchmark", "real-world-worker.mjs") }];
}));
fs.mkdirSync(output);
const result = { startedAt: new Date().toISOString(), workspace, commit, initialStatus, engines,
  order: [before, after, after, before], timeoutMs: 120000, node: process.version, platform: process.platform, runs: [],
  limitations: ["Same machine and repository; OS background load is not controlled", "A/B/B/A order reduces order bias but the sample is small", "RSS is sampled at worker completion, not peak memory"] };
const persist = () => fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
persist();
for (const [index, phase] of result.order.entries()) {
  const destination = path.join(output, `${index + 1}-${phase}.json`), start = Date.now();
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [engines[phase].worker, workspace, destination], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLUGIN_DATA: path.join(output, "state", String(index)) }
    });
    let stderr = "", timedOut = false;
    child.stdout.resume(); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
        catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    }, result.timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const scan = fs.existsSync(destination) ? read(destination) : null;
      resolve({ phase, exitCode, signal, timedOut, elapsedMs: Date.now() - start, stderr, destination,
        verifyMs: scan?.verifyMs, rssMiB: scan?.rssMiB,
        resultHash: scan?.report ? hash(JSON.stringify({ graph: scan.graph, report: scan.report })) : null });
    });
  });
  result.runs.push(run); persist(); console.log(JSON.stringify(run));
}
result.finalCommit = git("rev-parse", "HEAD"); result.finalStatus = git("status", "--porcelain");
result.completed = result.runs.every((run) => run.exitCode === 0 && !run.timedOut && run.resultHash);
result.identicalReports = result.completed && result.runs.every((run) => run.resultHash === result.runs[0].resultHash);
result.finishedAt = new Date().toISOString(); persist();
assert.equal(result.finalCommit, commit); assert.equal(result.finalStatus, initialStatus);
assert.ok(result.completed, "A performance run failed; see retained results");
assert.ok(result.identicalReports, "Performance-only changes must preserve complete reports");
console.log(JSON.stringify({ output, completed: result.completed, identicalReports: result.identicalReports }));
