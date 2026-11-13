import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generateWiringBlueprint, traceSymbolFlow } from "../src/flow-tools.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { clearFlowGraphCache } from "../src/graph-builder.mjs";
import { executeTool } from "../src/server.mjs";

const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const probeCommand = `"${process.execPath}" test/filter.test.mjs`;

function writeFiles(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  clearFlowGraphCache();
}

function withWorkspace(fn, { params = "score, threshold", body = "return score >= threshold;", calls = "console.log(applyFilter(0.9, cfg.detectionThreshold));" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard regression-"));
  try {
    writeFiles(dir, {
      "package.json": JSON.stringify({ name: "regression-app", private: true, type: "module" }),
      "src/config.mjs": `export class DetectorConfig {
  constructor() {
    this.detectionThreshold = 0.75;
  }
  setThreshold(value) {
    this.detectionThreshold = value;
  }
}`,
      "src/filter.mjs": `export function applyFilter(${params}) {
  ${body}
}`,
      "src/main.mjs": `import { DetectorConfig } from './config.mjs';
import { applyFilter } from './filter.mjs';
export function main() {
  const cfg = new DetectorConfig();
  cfg.setThreshold(0.99);
  ${calls}
}
main();`,
      "test/filter.test.mjs": `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyFilter } from '../src/filter.mjs';
function testThreshold() {
  fs.writeFileSync('.probe-ran', 'yes');
  assert.equal(applyFilter(0.9, 0.99), false);
  assert.equal(applyFilter(0.9, 0.5), true);
}
testThreshold();`
    });
    return fn(dir);
  } finally {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("flowguard regression-"));
    fs.rmSync(resolved, { recursive: true, force: true });
    clearFlowGraphCache();
  }
}

function verify(dir, options = {}) {
  const blueprint = generateWiringBlueprint(dir, "DetectorConfig", {
    targetField: "detectionThreshold",
    consumerTarget: "applyFilter",
    requirePersistence: "not_required",
    savePlan: false
  });
  return verifyWorkspaceFlow(dir, { fullScan: true, wiringPlan: blueprint.wiringPlan, ...options });
}

function obligation(report, layer) {
  const result = report.wiringReport.obligations.find((item) => item.layer === layer);
  assert.ok(result, `Expected ${layer} obligation`);
  return result;
}

function cli(dir, ...args) {
  return spawnSync(process.execPath, [server, "--cli", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: path.join(dir, ".flowguard-data") }
  });
}

test("L2 rejects a target passed to an unused parameter even when another parameter is read", () => {
  withWorkspace((dir) => {
    const report = verify(dir);
    assert.equal(obligation(report, "L2_DATA_FLOW").status, "VIOLATED");
    assert.equal(report.verificationVerdict, "VIOLATED");
    assert.equal(report.status, "ISSUES_FOUND");
    assert.ok(report.dataFlowBreaks.some((item) => item.unusedParams?.includes("threshold")));
  }, { body: "return score >= 0.75;" });
});

test("L2 preserves literal positions and exposes the matched argument in trace evidence", () => {
  withWorkspace((dir) => {
    const report = verify(dir);
    const data = obligation(report, "L2_DATA_FLOW");
    assert.equal(data.status, "SATISFIED");
    assert.ok(data.evidence.some((item) => item.includes("applyFilter.threshold (argument 2)")));
    const trace = traceSymbolFlow(dir, "applyFilter");
    assert.ok(JSON.stringify(trace).includes('"positionalArgs":[null,"cfg.detectionThreshold"]'));
  });
});

test("L2 does not deduplicate repeated arguments", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "SATISFIED");
  }, { body: "return threshold > 0;", calls: "console.log(applyFilter(cfg.detectionThreshold, cfg.detectionThreshold));" });
});

test("L2 examines later calls and multiline arguments", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "SATISFIED");
  }, { calls: "console.log(applyFilter(0.9, 0.5));\n  console.log(applyFilter(\n    0.9,\n    cfg.detectionThreshold\n  ));" });
});

test("L2 preserves underscore-prefixed parameter positions", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "SATISFIED");
  }, { params: "_unused, threshold", body: "return threshold > 0;" });
});

test("L2 requires an exact field token instead of a substring", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "VIOLATED");
  }, { calls: "console.log(applyFilter(0.9, cfg.detectionThresholdBackup));" });
});

test("L2 keeps spread argument binding inconclusive", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "INCONCLUSIVE");
  }, { calls: "const scores = [0.9];\n  console.log(applyFilter(...scores, cfg.detectionThreshold));" });
});

test("L2 does not treat a same-named parameter as evidence of the target's origin", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "VIOLATED");
  }, { params: "score, detectionThreshold", body: "return score >= detectionThreshold;", calls: "console.log(applyFilter(0.9, 0.75));" });
});

test("L2 keeps an ambiguous consumer name inconclusive", () => {
  withWorkspace((dir) => {
    writeFiles(dir, { "src/other.mjs": "export function applyFilter(score, threshold) {\n  return score >= threshold;\n}\n" });
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "INCONCLUSIVE");
  });
});

test("L2 accepts a field read directly by the consumer", () => {
  withWorkspace((dir) => {
    assert.equal(obligation(verify(dir), "L2_DATA_FLOW").status, "SATISFIED");
  }, { params: "score, cfg", body: "return score >= cfg.detectionThreshold;", calls: "console.log(applyFilter(0.9, cfg));" });
});

test("L3 stays inconclusive for unexecuted test code, including a failing test", () => {
  withWorkspace((dir) => {
    writeFiles(dir, { "test/filter.test.mjs": `import { applyFilter } from '../src/filter.mjs';
function testThreshold() {
  applyFilter(0.9, 0.99);
  throw new Error('Deliberate failure');
}
testThreshold();` });
    const report = verify(dir);
    const behavior = obligation(report, "L3_BEHAVIORAL");
    assert.equal(behavior.status, "INCONCLUSIVE");
    assert.ok(behavior.evidence.some((item) => item.includes("test/filter.test.mjs")));
    assert.equal(report.verificationVerdict, "INCONCLUSIVE");
    assert.equal(fs.existsSync(path.join(dir, ".probe-ran")), false);
  });
});

test("L3 reports successful execution of a real behavioral test", () => {
  withWorkspace((dir) => {
    const report = verify(dir, { runTestsCommand: probeCommand });
    assert.equal(obligation(report, "L3_BEHAVIORAL").status, "SATISFIED");
    assert.equal(report.verificationVerdict, "SATISFIED");
    assert.equal(fs.readFileSync(path.join(dir, ".probe-ran"), "utf8"), "yes");
  });
});

test("L3 remains inconclusive when no target test code is found", () => {
  withWorkspace((dir) => {
    writeFiles(dir, { "test/filter.test.mjs": "// No target tests yet.\n" });
    assert.equal(obligation(verify(dir), "L3_BEHAVIORAL").status, "INCONCLUSIVE");
  });
});

test("L3 reports a real failing test as violated", () => {
  withWorkspace((dir) => {
    const report = verify(dir, { runTestsCommand: probeCommand });
    assert.equal(obligation(report, "L3_BEHAVIORAL").status, "VIOLATED");
    assert.equal(report.verificationVerdict, "VIOLATED");
    assert.equal(fs.readFileSync(path.join(dir, ".probe-ran"), "utf8"), "yes");
  }, { body: "return score >= 0.75;" });
});

test("CLI blueprint flags persist the intended task and JSON arguments remain supported", () => {
  withWorkspace((dir) => {
    const result = cli(dir, "blueprint", dir, "DetectorConfig", "--target", "applyFilter", "--field", "detectionThreshold", "--consumer", "applyFilter", "--persist");
    assert.equal(result.status, 0, result.stderr);
    const spec = JSON.parse(result.stdout).wiringPlan.taskSpec;
    assert.equal(spec.targetSymbol, "applyFilter");
    assert.equal(spec.targetField, "detectionThreshold");
    assert.equal(spec.consumerTarget, "applyFilter");
    assert.equal(spec.requirePersistence, "required");
    const jsonResult = cli(dir, "blueprint", JSON.stringify({ workspaceRoot: dir, reference: "DetectorConfig", targetField: "detectionThreshold", consumerTarget: "applyFilter", requirePersistence: "not_required" }));
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const check = cli(dir, "verify", dir, "--full", "--allow-inconclusive");
    assert.equal(check.status, 0, check.stderr);
    const report = JSON.parse(check.stdout);
    assert.equal(report.wiringReport.source, "SHARED_BLUEPRINT_AND_DIFF");
    assert.equal(report.verificationVerdict, "INCONCLUSIVE");
  });
});

test("CLI returns 1 on violations and 0 on a satisfied scan", () => {
  withWorkspace((dir) => {
    const clean = cli(dir, "verify", dir, "--full");
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).verificationVerdict, "SATISFIED");
    writeFiles(dir, { "src/orphan.mjs": "export function newlyAddedFeature(input) {\n  return input.trim();\n}\n" });
    const planned = cli(dir, 'blueprint', dir, 'src/orphan.mjs', '--target', 'newlyAddedFeature');
    assert.equal(planned.status, 0, planned.stderr);
    const broken = cli(dir, "verify", dir, "--full");
    assert.equal(broken.status, 1, broken.stderr);
    assert.equal(JSON.parse(broken.stdout).verificationVerdict, "VIOLATED");
  });
});

test("INCONCLUSIVE is a distinct default status and advisory opt-in is boolean only", () => {
  withWorkspace((dir) => {
    const report = verify(dir);
    assert.equal(report.verificationVerdict, "INCONCLUSIVE");
    assert.equal(report.status, "INCONCLUSIVE");

    const advisory = verify(dir, { allowInconclusive: true });
    assert.equal(advisory.verificationVerdict, "INCONCLUSIVE");
    assert.equal(advisory.status, "INCONCLUSIVE");

    assert.throws(
      () => verify(dir, { allowInconclusive: "true" }),
      /allowInconclusive must be a boolean/
    );
    assert.throws(
      () => executeTool("flow_verify", { workspaceRoot: dir, allowInconclusive: "true" }),
      /(?:allowInconclusive must be a boolean|Invalid allowInconclusive: expected boolean)/
    );
  });
});

test("CLI defaults INCONCLUSIVE to exit 3, with advisory opt-in limited to exit behavior", () => {
  withWorkspace((dir) => {
    const blueprint = cli(dir, "blueprint", dir, "DetectorConfig", "--field", "detectionThreshold", "--consumer", "applyFilter");
    assert.equal(blueprint.status, 0, blueprint.stderr);
    const defaultResult = cli(dir, "verify", dir, "--full");
    assert.equal(defaultResult.status, 3, defaultResult.stderr);
    assert.equal(JSON.parse(defaultResult.stdout).status, "INCONCLUSIVE");

    const advisoryResult = cli(dir, "verify", dir, "--full", "--allow-inconclusive");
    assert.equal(advisoryResult.status, 0, advisoryResult.stderr);
    assert.equal(JSON.parse(advisoryResult.stdout).status, "INCONCLUSIVE");

    const invalidJson = cli(dir, "verify", JSON.stringify({ workspaceRoot: dir, fullScan: true, allowInconclusive: "true" }));
    assert.equal(invalidJson.status, 2, invalidJson.stdout);
    assert.match(invalidJson.stderr, /(?:allowInconclusive must be a boolean|Invalid allowInconclusive: expected boolean)/);
  });
});

test("allow-inconclusive never overrides violation or execution-error CLI exits", () => {
  withWorkspace((dir) => {
    writeFiles(dir, { "src/orphan.mjs": "export function newlyAddedFeature(input) {\n  return input.trim();\n}\n" });
    const planned = cli(dir, 'blueprint', dir, 'src/orphan.mjs', '--target', 'newlyAddedFeature');
    assert.equal(planned.status, 0, planned.stderr);
    const violation = cli(dir, "verify", dir, "--full", "--allow-inconclusive");
    assert.equal(violation.status, 1, violation.stderr);
    assert.equal(JSON.parse(violation.stdout).status, "ISSUES_FOUND");

    const executionError = cli(dir, "verify", dir, "--full", "--run-tests", "definitely-not-a-command", "--allow-inconclusive");
    assert.equal(executionError.status, 2, executionError.stderr);
    assert.equal(JSON.parse(executionError.stdout).status, "EXECUTION_ERROR");
  });
});

test("CLI runs explicit behavioral tests without an active blueprint", () => {
  withWorkspace((dir) => {
    const good = cli(dir, "verify", dir, "--full", "--run-tests", probeCommand);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(obligation(JSON.parse(good.stdout), "L3_BEHAVIORAL").status, "SATISFIED");
    writeFiles(dir, { "test/filter.test.mjs": "throw new Error('Deliberate test failure');" });
    const failed = cli(dir, "verify", dir, "--full", "--run-tests", probeCommand);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).verificationVerdict, "VIOLATED");
    assert.equal(JSON.parse(failed.stdout).status, "ISSUES_FOUND");
  });
});

test("CLI rejects missing values, unknown flags and invalid workspace paths", () => {
  withWorkspace((dir) => {
    const cases = [
      ["blueprint", dir, "DetectorConfig", "--field"],
      ["blueprint", dir, "DetectorConfig", "--field", "--persist"],
      ["blueprint", dir, "DetectorConfig", "--filed", "threshold"],
      ["verify", dir, "--base"],
      ["verify", dir, "--target", "applyFilter"],
      ["verify", path.join(dir, "missing-workspace")]
    ];
    for (const args of cases) {
      const result = cli(dir, ...args);
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, /FlowGuard CLI error:/);
      assert.equal(result.stdout, "");
    }
  });
});
