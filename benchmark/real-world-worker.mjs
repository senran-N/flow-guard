import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { buildWorkspaceFlowGraph } from "../src/graph-builder.mjs";

const [workspace, destination] = process.argv.slice(2);
const start = performance.now();
try {
  const report = verifyWorkspaceFlow(workspace, { fullScan: true, ignoreSavedPlan: true, sessionId: "corpus-scan", taskId: path.basename(workspace) });
  const verifyMs = Math.round(performance.now() - start);
  const graph = buildWorkspaceFlowGraph(workspace);
  const languages = {};
  for (const file of graph.files) languages[file.lang] = (languages[file.lang] || 0) + 1;
  const result = {
    repository: path.basename(workspace), workspace,
    verifyMs, totalMs: Math.round(performance.now() - start),
    rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    graph: { files: graph.files.length, prodFiles: graph.files.filter((f) => f.zone === "prod").length,
      symbols: graph.symbolById.size, languages, bridges: graph.crossBridges.length },
    report
  };
  fs.writeFileSync(destination, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ repository: result.repository, verifyMs, status: report.status, verdict: report.verificationVerdict,
    symbols: result.graph.symbols, violations: report.summary.obligationsViolated, output: destination }));
} catch (error) {
  fs.writeFileSync(destination, JSON.stringify({ workspace, error: error.stack, elapsedMs: Math.round(performance.now() - start) }, null, 2));
  process.exitCode = 2;
}
