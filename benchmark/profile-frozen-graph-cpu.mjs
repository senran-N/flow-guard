// Profile frozen graph construction only; it preserves the 120-second limit.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, phase, workspaceArg, outputName] = process.argv.slice(2);
assert.ok(evidenceRootArg && phase && workspaceArg && outputName, "Usage: node benchmark/profile-frozen-graph-cpu.mjs <evidence-root> <phase> <workspace> <output-name>");
const evidenceRoot = path.resolve(evidenceRootArg), workspace = path.resolve(workspaceArg), output = path.resolve(evidenceRoot, outputName);
assert.equal(path.dirname(output), evidenceRoot); assert.ok(!fs.existsSync(output));
const engine = path.join(evidenceRoot, `${phase}-corpus`, "engine-snapshot");
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const initialCommit = git("rev-parse", "HEAD"), initialStatus = git("status", "--porcelain");
fs.mkdirSync(output); fs.cpSync(path.join(engine, "src"), path.join(output, "src"), { recursive: true });
const worker = path.join(output, "worker.mjs");
fs.writeFileSync(worker, `import { performance } from 'node:perf_hooks'; import { buildWorkspaceFlowGraph } from './src/graph-builder.mjs'; const start=performance.now(); const graph=buildWorkspaceFlowGraph(process.argv[2], true); console.log(JSON.stringify({elapsedMs:Math.round(performance.now()-start),files:graph.files.length,symbols:graph.symbolById.size}));`);
const startedAt = new Date().toISOString(), start = Date.now();
const child = spawn(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${output}`, worker, workspace], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLUGIN_DATA: path.join(output, "state") } });
let stdout = "", stderr = "", timedOut = false;
child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => { timedOut = true; try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill("SIGKILL"); } }, 120000);
const { exitCode, signal } = await new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal })));
clearTimeout(timer);
const status = { startedAt, finishedAt: new Date().toISOString(), workspace, initialCommit, initialStatus, exitCode, signal, timedOut, elapsedMs: Date.now() - start, stdout, stderr, cpuProfiles: fs.readdirSync(output).filter((file) => file.endsWith(".cpuprofile")) };
status.finalCommit = git("rev-parse", "HEAD"); status.finalStatus = git("status", "--porcelain");
fs.writeFileSync(path.join(output, "status.json"), JSON.stringify(status, null, 2));
assert.equal(status.finalCommit, initialCommit); assert.equal(status.finalStatus, initialStatus); console.log(JSON.stringify(status));
