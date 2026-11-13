// Isolate the exact clone join after one frozen full graph build.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, phase, workspaceArg, outputName] = process.argv.slice(2);
assert.ok(evidenceRootArg && phase && workspaceArg && outputName, "Usage: node benchmark/profile-frozen-clones-cpu.mjs <evidence-root> <phase> <workspace> <output-name>");
const evidenceRoot = path.resolve(evidenceRootArg), workspace = path.resolve(workspaceArg), output = path.resolve(evidenceRoot, outputName);
assert.equal(path.dirname(output), evidenceRoot); assert.ok(!fs.existsSync(output));
const engine = path.join(evidenceRoot, `${phase}-corpus`, "engine-snapshot");
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const initialCommit = git("rev-parse", "HEAD"), initialStatus = git("status", "--porcelain");
fs.mkdirSync(output); fs.cpSync(path.join(engine, "src"), path.join(output, "src"), { recursive: true });
fs.writeFileSync(path.join(output, "worker.mjs"), `import { performance } from 'node:perf_hooks'; import { buildWorkspaceFlowGraph } from './src/graph-builder.mjs'; import { findSimilarShinglePairs } from './src/similarity-index.mjs'; const start=performance.now(); const graph=buildWorkspaceFlowGraph(process.argv[2],true); const built=Math.round(performance.now()-start); const symbols=[...graph.symbolById.values()].filter(s=>s.zone==='prod'&&(s.kind==='function'||s.kind==='method')&&s.shingles?.size); const pairs=findSimilarShinglePairs(symbols,0.85,(a,b)=>a.file!==b.file); console.log(JSON.stringify({graphMs:built,cloneMs:Math.round(performance.now()-start)-built,symbols:symbols.length,pairs:pairs.length}));`);
const startedAt = new Date().toISOString(), start = Date.now();
const child = spawn(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${output}`, path.join(output, "worker.mjs"), workspace], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLUGIN_DATA: path.join(output, "state") } });
let stdout = "", stderr = "", timedOut = false; child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
const timer = setTimeout(() => { timedOut = true; try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill("SIGKILL"); } }, 120000);
const { exitCode, signal } = await new Promise(resolve => child.on("close", (exitCode, signal) => resolve({exitCode,signal}))); clearTimeout(timer);
const status={startedAt,finishedAt:new Date().toISOString(),workspace,initialCommit,initialStatus,exitCode,signal,timedOut,elapsedMs:Date.now()-start,stdout,stderr,cpuProfiles:fs.readdirSync(output).filter(f=>f.endsWith('.cpuprofile'))}; status.finalCommit=git('rev-parse','HEAD');status.finalStatus=git('status','--porcelain');fs.writeFileSync(path.join(output,'status.json'),JSON.stringify(status,null,2));assert.equal(status.finalCommit,initialCommit);assert.equal(status.finalStatus,initialStatus);console.log(JSON.stringify(status));
