// Paired mutations of complete upstream source copies. These establish static
// wiring evidence; no Tauri application/runtime execution is claimed here.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [rootArg, corpusArg, phase = "phase9", cohortArg] = process.argv.slice(2);
const root = path.resolve(rootArg), corpus = path.resolve(corpusArg), output = path.join(root, `entry-source-cases-${phase}`);
assert.match(phase, /^phase\d+(?:-final\d+)?$/); assert.ok(!fs.existsSync(output)); fs.mkdirSync(output);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const cohort = cohortArg ? path.resolve(cohortArg) : path.join(root, `${phase}-corpus`);
const manifest = read(path.join(cohort, "manifest.json"));
const engine = path.join(cohort, "engine-snapshot", "src");
const { generateWiringBlueprint } = await import(pathToFileURL(path.join(engine, "flow-tools.mjs")));
const { verifyWorkspaceFlow } = await import(pathToFileURL(path.join(engine, "flow-verifier.mjs")));
const { clearFlowGraphCache } = await import(pathToFileURL(path.join(engine, "graph-builder.mjs")));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const original = path.join(corpus, "pot-desktop"), copy = path.join(output, "copy");
const initialStatus = git(original, "status", "--porcelain"), commit = git(original, "rev-parse", "HEAD");
assert.equal(initialStatus, ""); assert.equal(commit, manifest.repositories.find((r) => r.name === "pot-desktop").commit);
const archive = path.join(output, "source.tar");
git(original, "archive", "--format=tar", "-o", archive, "HEAD"); fs.mkdirSync(copy);
execFileSync("tar", ["-xf", archive, "-C", copy], { windowsHide: true });
git(copy, "init", "--quiet"); git(copy, "config", "core.autocrlf", "false"); git(copy, "add", ".");
git(copy, "-c", "user.name=FlowGuard Validation", "-c", "user.email=validation@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Upstream snapshot");
const file = "src-tauri/src/main.rs", target = path.join(copy, file), originalBytes = fs.readFileSync(target), source = originalBytes.toString("utf8");
const cases = [
  { symbol: "start_server", reference: "src-tauri/src/server.rs", token: "start_server();" },
  { symbol: "tray_event_handler", reference: "src-tauri/src/tray.rs", token: ".on_system_tray_event(tray_event_handler)" }
];
const results = [];
process.env.PLUGIN_DATA = path.join(output, "state");
for (const item of cases) {
  assert.equal(source.split(item.token).length, 2, "The real source mutation must have one exact site");
  const blueprint = generateWiringBlueprint(copy, item.reference, { targetSymbol: item.symbol, savePlan: false, requirePersistence: "not_required" });
  for (const variant of ["control", "defect"]) {
    const directory = path.join(output, `${item.symbol}-${variant}`); fs.mkdirSync(directory);
    const changed = source.replace(item.token, variant === "control" ? " " + item.token : "");
    fs.writeFileSync(target, changed); clearFlowGraphCache();
    try {
      fs.writeFileSync(path.join(directory, "change.patch"), git(copy, "diff", "--", file));
      const modes = {};
      for (const mode of ["full", "incremental", "planned"]) {
        const report = verifyWorkspaceFlow(copy, { ...(mode === "incremental" ? { baseRef: "HEAD" } : { fullScan: true }),
          ...(mode === "planned" ? { wiringPlan: blueprint.wiringPlan } : {}), ignoreSavedPlan: true });
        fs.writeFileSync(path.join(directory, `${mode}.json`), JSON.stringify(report, null, 2));
        const findings = report.wiringReport.obligations.filter((o) => o.station === "ENTRY_WIRING" &&
          (mode === "planned" ? o.checkSpec?.targetSymbol === item.symbol : o.targetLocation?.includes(item.symbol)));
        modes[mode] = { targetStatuses: findings.map((o) => o.status), verdict: report.verificationVerdict };
        const candidateCallback = Number.parseInt(phase.slice(5), 10) >= 12 && item.symbol === "tray_event_handler";
        if (mode === "planned") assert.deepEqual(modes[mode].targetStatuses,
          [variant === "control" ? candidateCallback ? "INCONCLUSIVE" : "SATISFIED" : "VIOLATED"]);
        if (variant === "control") assert.ok(findings.every((o) => o.status !== "VIOLATED"));
        if (variant === 'defect' && mode === 'incremental' && Number.parseInt(phase.slice(5), 10) >= 16) {
          assert.ok(findings.some(o => o.status === 'VIOLATED'), 'Removing an existing callback registration must be detected incrementally');
        }
        if (variant === "defect" && mode === "full") {
          const expected = Number.parseInt(phase.slice(5), 10) >= 15 ? 'INCONCLUSIVE' : 'VIOLATED';
          assert.ok(findings.some((o) => o.status === expected));
        }
      }
      results.push({ symbol: item.symbol, variant, modes });
      fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ sourceHash: manifest.engine.sourceHash, commit, results,
        limitations: ["Real upstream source mutations with static expectations, not executed Tauri behavior", "Cases used during development; not an independent accuracy estimate"] }, null, 2));
    } finally { fs.writeFileSync(target, originalBytes); clearFlowGraphCache(); }
  }
}
assert.equal(git(copy, "status", "--porcelain"), ""); assert.equal(git(original, "status", "--porcelain"), initialStatus);
assert.equal(git(original, "rev-parse", "HEAD"), commit);
fs.writeFileSync(path.join(output, "provenance.json"), JSON.stringify({ original, copy, commit, initialStatus,
  originalFinalStatus: git(original, "status", "--porcelain"), copyFinalStatus: git(copy, "status", "--porcelain"),
  sourceFile: file, sourceFileHash: crypto.createHash("sha256").update(originalBytes).digest("hex") }, null, 2));
console.log(JSON.stringify({ output, results }));
