import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { cases } from "./real-world-cases.mjs";

const root = path.resolve(process.argv[2]);
const output = path.resolve(root, process.argv[3] || "explicit-plans");
assert.equal(path.dirname(output), root);
assert.ok(!fs.existsSync(output), "Existing evidence is never overwritten");
fs.mkdirSync(output);
const worker = fileURLToPath(new URL("./real-world-case-worker.mjs", import.meta.url));
const completed = JSON.parse(fs.readFileSync(path.join(root, "mutations", "results.json"), "utf8"));
const results = [];
function run(copy, destination, mode, spec) {
  const proc = spawnSync(process.execPath, [worker, copy, destination, mode, spec], {
    encoding: "utf8", windowsHide: true, timeout: 120000,
    env: { ...process.env, PLUGIN_DATA: path.join(output, "state") }
  });
  if (proc.error || proc.status !== 0) return {
    engineError: fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, "utf8")).error : proc.error?.message || proc.stderr,
    exitCode: proc.status
  };
  return JSON.parse(fs.readFileSync(destination, "utf8"));
}
for (const item of cases.filter((c) => c.param)) {
  const copy = path.join(root, "mutations", "copies", item.repo);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: copy, encoding: "utf8" }).trim(), "");
  const dir = path.join(output, item.id); fs.mkdirSync(dir);
  const spec = path.join(dir, "case.json"); fs.writeFileSync(spec, JSON.stringify(item, null, 2));
  const blueprint = path.join(dir, "blueprint.json");
  const generated = run(copy, blueprint, "blueprint", spec);
  assert.ok(generated.wiringPlan, `Could not generate blueprint: ${generated.engineError}`);
  const originals = new Map(item.changes.map((c) => [c.file, fs.readFileSync(path.join(copy, c.file), "utf8")]));
  for (const variant of ["control", "defect"]) {
    try {
      assert.ok(completed.some((r) => r.id === item.id && r.variant === variant && r.behavior.passed === (variant === "control")));
      for (const change of item.changes) {
        const target = path.join(copy, change.file);
        const before = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
        assert.equal(before.split(change.before).length, 2);
        fs.writeFileSync(target, before.replace(change.before, change[variant]));
      }
      const patch = execFileSync("git", ["diff", "--no-ext-diff", "--no-color"], { cwd: copy, encoding: "utf8" });
      assert.equal(patch, fs.readFileSync(path.join(root, "mutations", "cases", item.id, variant, "change.patch"), "utf8"), "Probe evidence must correspond to exactly the same patch");
      const scan = run(copy, path.join(dir, `${variant}.json`), "incremental", blueprint);
      if (scan.engineError) {
        const row = { id: item.id, variant, holdout: !!item.holdout, ...scan };
        results.push(row); fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(row));
        continue;
      }
      const obligations = scan.report.wiringReport.obligations.filter((o) => o.layer === "L2_DATA_FLOW" && o.checkSpec?.targetSymbol === item.symbol);
      assert.ok(obligations.length, "Explicit L2 obligation must exist");
      const row = { id: item.id, variant, holdout: !!item.holdout, l2: obligations.map((o) => ({ id: o.id, status: o.status, finding: o.finding })),
        targetedViolation: obligations.some((o) => o.status === "VIOLATED"), overallVerdict: scan.report.verificationVerdict };
      results.push(row); fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(row));
    } finally {
      for (const [file, content] of originals) fs.writeFileSync(path.join(copy, file), content);
    }
  }
}
