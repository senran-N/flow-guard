import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const [workspace, destination, mode] = process.argv.slice(2);
if (!workspace || !destination) throw new Error("Usage: node benchmark/profile-graph.mjs <workspace> <new-profile-directory>");
if (fs.existsSync(destination)) throw new Error("Existing evidence must not be overwritten");
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(path.join(sourceRoot, "src"), path.join(destination, "src"), { recursive: true });
const builder = path.join(destination, "src", "graph-builder.mjs");
const original = fs.readFileSync(builder, "utf8");
const instrumented = original.replace(/^(  \/\/ [1-6]\. .+)$/gm, (comment) =>
  `  console.error(JSON.stringify({ phase: ${JSON.stringify(comment.trim())}, ms: Math.round(performance.now()), rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));\n${comment}`);
fs.writeFileSync(builder, instrumented);
if (mode === "--verify") {
  const verifier = path.join(destination, "src", "flow-verifier.mjs");
  fs.writeFileSync(verifier, fs.readFileSync(verifier, "utf8").replace(/^(  \/\/ [1-7]\. .+)$/gm, (comment) =>
    `  console.error(JSON.stringify({phase:${JSON.stringify("verify " + comment.trim())},ms:Math.round(performance.now()),rssMiB:Math.round(process.memoryUsage().rss/1048576)}));\n${comment}`));
  fs.writeFileSync(path.join(destination, "worker.mjs"), `import {verifyWorkspaceFlow} from './src/flow-verifier.mjs';\nconsole.error(JSON.stringify({phase:'start',ms:Math.round(performance.now())}));\nconst report=verifyWorkspaceFlow(process.argv[2],{fullScan:true,ignoreSavedPlan:true});\nconsole.error(JSON.stringify({phase:'done',ms:Math.round(performance.now()),summary:report.summary}));`);
} else {
  fs.writeFileSync(path.join(destination, "worker.mjs"), `import { buildWorkspaceFlowGraph } from './src/graph-builder.mjs';\nconsole.error(JSON.stringify({phase:'start',ms:Math.round(performance.now())}));\nconst graph=buildWorkspaceFlowGraph(process.argv[2],true);\nconsole.error(JSON.stringify({phase:'done',ms:Math.round(performance.now()),files:graph.files.length,symbols:graph.symbolById.size}));\n`);
}
const result = spawnSync(process.execPath, [path.join(destination, "worker.mjs"), path.resolve(workspace)], {
  windowsHide: true, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024
});
fs.writeFileSync(path.join(destination, "phases.jsonl"), result.stderr || "");
fs.writeFileSync(path.join(destination, "status.json"), JSON.stringify({ exitCode: result.status, signal: result.signal, error: result.error?.message }, null, 2));
console.log(result.stderr);
console.log(JSON.stringify({ exitCode: result.status, signal: result.signal, error: result.error?.message }));
