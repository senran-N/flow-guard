import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { cases } from "./real-world-cases.mjs";

const [corpusArg, validationArg, runName = "mutations"] = process.argv.slice(2);
if (!corpusArg || !validationArg) throw new Error("Usage: node benchmark/real-world-mutations.mjs <corpus> <validation-directory> [run-name]");
const corpus = path.resolve(corpusArg), validation = path.resolve(validationArg);
const output = path.resolve(validation, runName);
assert.equal(path.dirname(output), validation, "Run directory must be directly under validation directory");
assert.ok(!fs.existsSync(output), "Use a new run name; existing evidence is never overwritten");
fs.mkdirSync(output, { recursive: true });
const worker = fileURLToPath(new URL("./real-world-case-worker.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
const writeJson = (dest, data) => fs.writeFileSync(dest, JSON.stringify(data, null, 2));
writeJson(path.join(output, "cases.json"), cases);
const copies = new Map(), provenance = [], results = [];
for (const item of cases) {
  if (copies.has(item.repo)) continue;
  const original = path.join(item.holdout ? path.join(validation, "holdouts") : corpus, item.repo);
  assert.equal(git(original, "status", "--porcelain").trim(), "", `${item.repo} must be clean`);
  const copy = path.join(output, "copies", item.repo), archive = path.join(output, `${item.repo}.tar`);
  fs.mkdirSync(copy, { recursive: true });
  git(original, "archive", "--format=tar", "-o", archive, "HEAD");
  execFileSync("tar", ["-xf", archive, "-C", copy], { windowsHide: true, stdio: "pipe" });
  git(copy, "init", "--quiet");
  git(copy, "config", "core.autocrlf", "false");
  git(copy, "add", "-A");
  git(copy, "-c", "user.email=benchmark@flowguard.local", "-c", "user.name=FlowGuard Benchmark", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Unmodified upstream snapshot");
  copies.set(item.repo, copy);
  provenance.push({ repository: item.repo, original, copy, upstreamCommit: git(original, "rev-parse", "HEAD").trim(), copyCommit: git(copy, "rev-parse", "HEAD").trim() });
}
writeJson(path.join(output, "provenance.json"), provenance);

function verify(copy, destination, mode) {
  const result = spawnSync(process.execPath, [worker, copy, destination, mode], { encoding: "utf8", windowsHide: true, timeout: 120000,
    env: { ...process.env, PLUGIN_DATA: path.join(output, "state") }, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { error: result.error?.message || result.stderr, exitCode: result.status };
  return JSON.parse(fs.readFileSync(destination, "utf8"));
}
function bracedFunction(source, name, language) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = source.search(new RegExp(language === "go" ? `^func ${escaped}\\(` : language === "typescript" ? `^export const ${escaped} =` : `^function ${escaped}\\(`, "m"));
  assert.ok(start >= 0, `Function ${name} not found`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `Function ${name} end not found`);
  return source.slice(start, end + 2);
}
function probe(item, copy, dir) {
  const sourceFile = path.join(copy, item.changes[0].file);
  const source = fs.readFileSync(sourceFile, "utf8").replace(/\r\n/g, "\n");
  if (item.language === "bridge") {
    const client = fs.readFileSync(path.join(copy, "src/utils/store.js"), "utf8");
    const command = client.match(/invoke\(['"](reload_store[^'"]*)['"]\)/)?.[1];
    const backend = fs.readFileSync(path.join(copy, "src-tauri/src/cmd.rs"), "utf8");
    const registry = fs.readFileSync(path.join(copy, "src-tauri/src/main.rs"), "utf8");
    const declared = backend.includes(`pub fn ${command}()`), registered = registry.includes(`            ${command},`);
    const result = { kind: "static-command-contract", command, declared, registered, passed: !!command && declared && registered };
    writeJson(path.join(dir, "probe.json"), result);
    return result;
  }
  let executable, args, program, extension;
  if (item.language === "python") {
    executable = "python"; extension = "py";
    program = `from __future__ import annotations\nimport ast, os, typing, sys\nsource = open(${JSON.stringify(sourceFile)}, encoding="utf-8").read()\ntree = ast.parse(source)\nfn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == ${JSON.stringify(item.symbol)})\nexec(compile(ast.Module(body=[fn], type_ignores=[]), ${JSON.stringify(sourceFile)}, "exec"))\n${item.assertion}\n`;
  } else if (item.language === "go") {
    executable = "go"; extension = "go";
    program = `package main\nimport (${item.imports.map((s) => JSON.stringify(s)).join(";")})\n${[...(item.helpers || []), item.symbol].map((s) => bracedFunction(source, s, "go")).join("\n")}\nfunc main() { ${item.assertion} }\n`;
  } else {
    executable = process.execPath; extension = "mjs";
    let body = bracedFunction(source, item.symbol, item.language);
    if (item.language === "typescript") body = stripTypeScriptTypes(body).replace(/^export /, "");
    program = `import assert from 'node:assert/strict';\n${body}\n${item.assertion};\n`;
  }
  const script = path.join(dir, `probe.${extension}`);
  fs.writeFileSync(script, program);
  args = item.language === "go" ? ["run", script] : [script];
  const run = spawnSync(executable, args, { cwd: dir, windowsHide: true, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, GO111MODULE: "off", GOTOOLCHAIN: "local" } });
  const infrastructureFailure = !!run.error || (item.language === "go" && /syntax error|undefined:|not used|cannot find/.test(run.stderr || ""));
  const result = { kind: "isolated-real-function-execution", passed: run.status === 0, infrastructureFailure, status: run.status, error: run.error?.message || null, stdout: run.stdout, stderr: run.stderr };
  writeJson(path.join(dir, "probe.json"), result);
  return result;
}
function detection(item, scan) {
  if (!scan.report) return { error: scan.error, detected: false, targetedViolation: false };
  const report = scan.report;
  const locations = item.changes.map((c) => c.file);
  const applies = (value) => locations.some((f) => value.includes(f)) && value.includes(item.symbol);
  const diagnostics = (item.language === "bridge" ? report.brokenBridges || [] : report.dataFlowBreaks || []).filter((f) => {
    const json = JSON.stringify(f);
    return item.language === "bridge" ? json.includes("reload_store") : applies(json) && f.unusedParams?.includes(item.param);
  });
  const violations = report.wiringReport.obligations.filter((o) => o.status === "VIOLATED" && applies(JSON.stringify(o)) &&
    (item.language === "bridge" ? /桥|跨界|跨语言|断链|reload_store/.test(JSON.stringify(o)) : o.layer === "L2_DATA_FLOW" && JSON.stringify(o).includes(item.param)));
  // Full scans also gate on brokenBridges outside wiringReport.obligations.
  const bridgeBlocked = item.language === "bridge" && diagnostics.length > 0 && report.verificationVerdict === "VIOLATED";
  return { detected: diagnostics.length > 0 || violations.length > 0, targetedViolation: violations.length > 0 || bridgeBlocked, overallVerdict: report.verificationVerdict, scanMode: report.scanMode, diagnostics, violations };
}

const baseline = new Map();
for (const [repo, copy] of copies) {
  const dir = path.join(output, "baseline", repo); fs.mkdirSync(dir, { recursive: true });
  baseline.set(repo, Object.fromEntries(["full", "incremental"].map((mode) => [mode, verify(copy, path.join(dir, `${mode}.json`), mode)])));
}
for (const item of cases) {
  const copy = copies.get(item.repo);
  const originals = new Map(item.changes.map((c) => [c.file, fs.readFileSync(path.join(copy, c.file), "utf8")]));
  const itemDir = path.join(output, "cases", item.id); fs.mkdirSync(itemDir, { recursive: true });
  const originalProbe = probe(item, copy, itemDir);
  assert.ok(originalProbe.passed, `Original behavior probe failed for ${item.id}: ${originalProbe.stderr}`);
  for (const variant of ["control", "defect"]) {
    const dir = path.join(itemDir, variant); fs.mkdirSync(dir, { recursive: true });
    try {
      for (const [file, content] of originals) fs.writeFileSync(path.join(copy, file), content);
      for (const modification of item.changes) {
        const target = path.join(copy, modification.file);
        const before = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
        assert.equal(before.split(modification.before).length, 2, `${item.id}: edit must match exactly once`);
        fs.writeFileSync(target, before.replace(modification.before, modification[variant]));
      }
      fs.writeFileSync(path.join(dir, "change.patch"), git(copy, "diff", "--no-ext-diff", "--no-color"));
      const behavior = probe(item, copy, dir);
      assert.ok(!behavior.infrastructureFailure, `Probe infrastructure failed: ${item.id}: ${behavior.stderr}`);
      assert.equal(behavior.passed, variant === "control", `Invalid ground truth: ${item.id} ${variant}`);
      const scans = {};
      for (const mode of ["full", "incremental"]) {
        const scan = verify(copy, path.join(dir, `${mode}.json`), mode);
        const current = detection(item, scan), before = detection(item, baseline.get(item.repo)[mode]);
        scans[mode] = { ...current, baselineDetected: before.detected, newlyDetected: current.detected && !before.detected, newTargetedViolation: current.targetedViolation && !before.targetedViolation };
      }
      const result = { id: item.id, repository: item.repo, holdout: !!item.holdout, variant, behavior, scans };
      results.push(result); writeJson(path.join(output, "results.json"), results);
      console.log(JSON.stringify({ id: item.id, variant, probePassed: behavior.passed, full: scans.full.newlyDetected, incremental: scans.incremental.newlyDetected, blocking: scans.incremental.newTargetedViolation }));
    } finally {
      for (const [file, content] of originals) fs.writeFileSync(path.join(copy, file), content);
    }
  }
}
for (const record of provenance) {
  record.originalFinalStatus = git(record.original, "status", "--porcelain").trim();
  record.copyFinalStatus = git(record.copy, "status", "--porcelain").trim();
}
writeJson(path.join(output, "provenance.json"), provenance);
console.log(JSON.stringify({ completed: results.length, output }));
