import fs from "node:fs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { generateWiringBlueprint } from "../src/flow-tools.mjs";
const [workspace, destination, mode, specPath] = process.argv.slice(2);
try {
  const start = performance.now();
  if (mode === "blueprint") {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    const blueprint = generateWiringBlueprint(workspace, spec.changes[0].file, {
      targetSymbol: spec.symbol, requirePersistence: "not_required", savePlan: false,
      sessionId: "real-world-mutations", taskId: "paired-evaluation"
    });
    fs.writeFileSync(destination, JSON.stringify(blueprint, null, 2));
    process.exit(0);
  }
  const report = verifyWorkspaceFlow(workspace, {
    ...(mode === "full" ? { fullScan: true } : { baseRef: "HEAD" }),
    ...(specPath ? { wiringPlan: JSON.parse(fs.readFileSync(specPath, "utf8")).wiringPlan } : {}),
    ignoreSavedPlan: true, sessionId: "real-world-mutations", taskId: "paired-evaluation"
  });
  fs.writeFileSync(destination, JSON.stringify({ elapsedMs: Math.round(performance.now() - start), report }, null, 2));
} catch (error) {
  fs.writeFileSync(destination, JSON.stringify({ error: error.stack }, null, 2));
  process.exitCode = 2;
}
