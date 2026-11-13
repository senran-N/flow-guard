// Capture one bounded V8 CPU profile from a frozen engine snapshot.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, phase, workspaceArg, outputName] = process.argv.slice(2);
assert.ok(evidenceRootArg && phase && workspaceArg && outputName, "Usage: node benchmark/profile-frozen-cpu.mjs <evidence-root> <phase> <workspace> <output-name>");
const evidenceRoot = path.resolve(evidenceRootArg), workspace = path.resolve(workspaceArg), output = path.resolve(evidenceRoot, outputName);
assert.match(phase, /^phase\d+$/);
assert.equal(path.dirname(output), evidenceRoot, "output must be directly inside the evidence root");
assert.ok(!fs.existsSync(output), "profile output must not be overwritten");
const engine = path.join(evidenceRoot, `${phase}-corpus`, "engine-snapshot");
const worker = path.join(engine, "benchmark", "real-world-worker.mjs");
assert.ok(fs.existsSync(worker), `missing frozen worker: ${worker}`);
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const initialCommit = git("rev-parse", "HEAD"), initialStatus = git("status", "--porcelain");
fs.mkdirSync(output);
const destination = path.join(output, "scan.json"), startedAt = new Date().toISOString(), start = Date.now();
const child = spawn(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${output}`, worker, workspace, destination], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLUGIN_DATA: path.join(output, "state") }
});
let stdout = "", stderr = "", timedOut = false;
child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => {
  timedOut = true;
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
  catch { child.kill("SIGKILL"); }
}, 120000);
const { exitCode, signal } = await new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal })));
clearTimeout(timer);
const status = { startedAt, finishedAt: new Date().toISOString(), workspace, initialCommit, initialStatus,
  exitCode, signal, timedOut, elapsedMs: Date.now() - start, stdout, stderr, destination,
  cpuProfiles: fs.readdirSync(output).filter((file) => file.endsWith(".cpuprofile")) };
status.finalCommit = git("rev-parse", "HEAD"); status.finalStatus = git("status", "--porcelain");
fs.writeFileSync(path.join(output, "status.json"), JSON.stringify(status, null, 2));
assert.equal(status.finalCommit, initialCommit); assert.equal(status.finalStatus, initialStatus);
console.log(JSON.stringify(status));
