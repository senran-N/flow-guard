// Profile real verifier stages from an immutable phase snapshot. Each completed
// stage is synchronously appended, preserving evidence even if the hard limit ends it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, phase, workspaceArg, outputName] = process.argv.slice(2);
assert.ok(evidenceRootArg && phase && workspaceArg && outputName,
  "Usage: node benchmark/profile-frozen-verifier-stages.mjs <evidence-root> <phase> <workspace> <output-name>");
const evidenceRoot = path.resolve(evidenceRootArg), workspace = path.resolve(workspaceArg);
const output = path.resolve(evidenceRoot, outputName), frozen = path.join(evidenceRoot, `${phase}-corpus`, "engine-snapshot");
assert.equal(path.dirname(output), evidenceRoot); assert.ok(!fs.existsSync(output)); assert.ok(fs.existsSync(frozen));
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
const initialCommit = git("rev-parse", "HEAD"), initialStatus = git("status", "--porcelain");
fs.mkdirSync(output); const engine = path.join(output, "engine"); fs.cpSync(frozen, engine, { recursive: true });
const verifierPath = path.join(engine, "src", "flow-verifier.mjs");
let verifier = fs.readFileSync(verifierPath, "utf8").replace(/\r\n/g, "\n");
const replaceOne = (from, to, label) => { assert.ok(verifier.includes(from), `cannot instrument ${label}`); verifier = verifier.replace(from, to); };
replaceOne('import path from "node:path";', 'import fs from "node:fs";\nimport path from "node:path";\nimport { performance } from "node:perf_hooks";', "performance import");
replaceOne('export function verifyWorkspaceFlow(workspaceRoot, options = {}) {', `export function verifyWorkspaceFlow(workspaceRoot, options = {}) {
  const stageStarted = performance.now();
  const markStage = (stage) => {
    if (!options.profileStageLog) return;
    fs.appendFileSync(options.profileStageLog, JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - stageStarted), rssMiB: Math.round(process.memoryUsage().rss / 1048576) }) + "\\n");
  };
  markStage("verify-start");`, "verifier start");
replaceOne('  const gitStatus = getGitWorkingTreeStatus(workspaceRoot);', '  markStage("graph");\n  const gitStatus = getGitWorkingTreeStatus(workspaceRoot);', "graph stage");
replaceOne('  const rawChangedFiles = baselineBundle ? baselineBundle.changedFiles : gitStatus.changedFiles;', '  markStage("baseline");\n  const rawChangedFiles = baselineBundle ? baselineBundle.changedFiles : gitStatus.changedFiles;', "baseline stage");
replaceOne('  for (const sym of graph.symbolById.values()) {\n    if (sym.zone !== "prod") continue;\n    const symShort = shortId(sym);', '  markStage("main-symbol-loop-start");\n  for (const sym of graph.symbolById.values()) {\n    if (sym.zone !== "prod") continue;\n    const symShort = shortId(sym);', "main loop start");
replaceOne('  // 5. Asymmetric Paired Updates in Changed Files + Field-Level Save/Load Asymmetries', '  markStage("main-symbol-loop");\n\n  // 5. Asymmetric Paired Updates in Changed Files + Field-Level Save/Load Asymmetries', "main loop end");
replaceOne('  // 6. Structural Clone Sprawl Detection (normalized lexical shingle Jaccard)', '  markStage("clone-start");\n\n  // 6. Structural Clone Sprawl Detection (normalized lexical shingle Jaccard)', "clone start");
replaceOne('  // 7. Task-Oriented Tri-State Wiring Contract Evaluation (`SATISFIED` / `VIOLATED` / `INCONCLUSIVE`)', '  markStage("clones");\n\n  // 7. Task-Oriented Tri-State Wiring Contract Evaluation (`SATISFIED` / `VIOLATED` / `INCONCLUSIVE`)', "clone end");
replaceOne('  // In full-workspace scan without git diff, also surface `unwiredExports` in application mode as VIOLATED obligations!', '  markStage("evaluateWiringContracts");\n\n  // In full-workspace scan without git diff, also surface `unwiredExports` in application mode as VIOLATED obligations!', "contract end");
replaceOne('  return {\n    stateScope:', '  markStage("report-assembly-start");\n  const report = {\n    stateScope:', "return object");
replaceOne('    antiPatterns: antiPatterns.slice(0, 10)\n  };\n}', '    antiPatterns: antiPatterns.slice(0, 10)\n  };\n  markStage("return");\n  return report;\n}', "return end");
fs.writeFileSync(verifierPath, verifier);
const worker = path.join(output, "worker.mjs"), stageLog = path.join(output, "stages.jsonl"), destination = path.join(output, "scan.json");
fs.writeFileSync(worker, `import fs from "node:fs"; import { performance } from "node:perf_hooks"; import { verifyWorkspaceFlow } from "./engine/src/flow-verifier.mjs"; import { buildWorkspaceFlowGraph } from "./engine/src/graph-builder.mjs"; const [workspace, destination, stageLog] = process.argv.slice(2); const start=performance.now(); try { const report=verifyWorkspaceFlow(workspace,{fullScan:true,ignoreSavedPlan:true,profileStageLog:stageLog,sessionId:"phase10-stage-profile",taskId:"phase10-stage-profile"}); const verifyMs=Math.round(performance.now()-start); fs.appendFileSync(stageLog,JSON.stringify({stage:"worker-second-cachebuild-start",elapsedMs:verifyMs,rssMiB:Math.round(process.memoryUsage().rss/1048576)})+"\\n"); const graph=buildWorkspaceFlowGraph(workspace); const totalMs=Math.round(performance.now()-start); fs.appendFileSync(stageLog,JSON.stringify({stage:"worker-second-cachebuild",elapsedMs:totalMs,rssMiB:Math.round(process.memoryUsage().rss/1048576)})+"\\n"); fs.writeFileSync(destination,JSON.stringify({verifyMs,totalMs,graph:{files:graph.files.length,symbols:graph.symbolById.size},report},null,2)); } catch (error) { fs.appendFileSync(stageLog,JSON.stringify({stage:"error",elapsedMs:Math.round(performance.now()-start),error:error.stack})+"\\n"); fs.writeFileSync(destination,JSON.stringify({error:error.stack},null,2)); process.exitCode=2; }`);
const startedAt = new Date().toISOString(), started = Date.now();
const child = spawn(process.execPath, [worker, workspace, destination, stageLog], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLUGIN_DATA: path.join(output, "state") } });
let stdout = "", stderr = "", timedOut = false; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => { timedOut = true; try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill("SIGKILL"); } }, 120000);
const { exitCode, signal } = await new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal }))); clearTimeout(timer);
const result = { startedAt, finishedAt: new Date().toISOString(), workspace, initialCommit, initialStatus, exitCode, signal, timedOut, elapsedMs: Date.now() - started, stdout, stderr,
  stages: fs.existsSync(stageLog) ? fs.readFileSync(stageLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] };
result.finalCommit = git("rev-parse", "HEAD"); result.finalStatus = git("status", "--porcelain");
fs.writeFileSync(path.join(output, "status.json"), JSON.stringify(result, null, 2));
assert.equal(result.finalCommit, initialCommit); assert.equal(result.finalStatus, initialStatus); console.log(JSON.stringify(result));
