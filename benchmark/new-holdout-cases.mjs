// A separate post-hardening evaluation. Do not tune the captured engine on these cases.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2]);
const output = path.resolve(root, process.argv[3] || "new-holdout-cases");
assert.equal(path.dirname(output), root);
assert.ok(!fs.existsSync(output), "Use a new evidence directory");
fs.mkdirSync(output);
const scanRun = process.argv[4] || "phase2-new-holdouts";
const frozenEngine = path.join(root, scanRun, "engine-snapshot");
const worker = path.join(frozenEngine, "benchmark", "real-world-case-worker.mjs");
fs.copyFileSync(fileURLToPath(new URL("./real-world-case-worker.mjs", import.meta.url)), worker);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dest, value) => fs.writeFileSync(dest, JSON.stringify(value, null, 2));
const definitions = [
  { repo: "yocto-queue", file: "index.js", symbol: "enqueue", param: "value", description: "enqueue must preserve the supplied item",
    edit: (source, defect) => source.replace("const node = new Node(value);", `const node = new Node(${defect ? "undefined" : "(value)"});`),
    probe(copy, directory) {
      const file = path.join(directory, "probe.mjs");
      fs.writeFileSync(file, `import assert from 'node:assert/strict';\nimport Queue from ${JSON.stringify(new URL("file:///" + path.join(copy, "index.js").replace(/\\/g, "/")).href)};\nconst q = new Queue(); q.enqueue('first'); q.enqueue('second'); assert.equal(q.size, 2); assert.equal(q.peek(), 'first'); assert.equal(q.dequeue(), 'first'); assert.equal(q.dequeue(), 'second'); assert.equal(q.size, 0);`);
      return [process.execPath, [file]];
    }
  },
  { repo: "packaging", file: "src/packaging/utils.py", symbol: "canonicalize_name", param: "validate", description: "requested validation must reject invalid distribution names",
    edit: (source, defect) => source.replace("if validate and not _validate_regex.fullmatch(name):", `if ${defect ? "False" : "bool(validate)"} and not _validate_regex.fullmatch(name):`),
    probe(copy, directory) {
      const file = path.join(directory, "probe.py");
      fs.writeFileSync(file, `import sys\nsys.path.insert(0, ${JSON.stringify(path.join(copy, "src"))})\nfrom packaging.utils import canonicalize_name, InvalidName\nassert canonicalize_name('My_Package.Name') == 'my-package-name'\ntry:\n    canonicalize_name('bad!name', validate=True)\nexcept InvalidName:\n    pass\nelse:\n    raise AssertionError('validation was silently dropped')\n`);
      return ["python", ["-B", file]];
    }
  },
  { repo: "httprouter", file: "path.go", symbol: "CleanPath", param: "p", description: "path normalization must use the provided path",
    edit(source, defect) {
      const begin = source.indexOf("func CleanPath(p string) string {") + "func CleanPath(p string) string {".length;
      assert.ok(begin > 33);
      const end = source.indexOf("\n}", begin);
      return source.slice(0, begin) + `\n\tnormalizedInput := ${defect ? '"/"' : "p"}\n` + source.slice(begin, end).replace(/\bp\b/g, "normalizedInput") + source.slice(end);
    },
    probe(copy, directory) {
      fs.copyFileSync(path.join(copy, "path.go"), path.join(directory, "path.go"));
      fs.writeFileSync(path.join(directory, "probe_test.go"), `package httprouter\nimport "testing"\nfunc TestFlowGuardPath(t *testing.T) { for in, want := range map[string]string{"/a/../b": "/b", "//x//y/": "/x/y/", "": "/"} { if got := CleanPath(in); got != want { t.Fatalf("%q: got %q, want %q", in, got, want) } } }\n`);
      return ["go", ["test", "path.go", "probe_test.go", "-count=1"]];
    }
  }
];
const results = [], provenance = [];
const runWorker = (copy, destination, mode, spec) => {
  const proc = spawnSync(process.execPath, [worker, copy, destination, mode, ...(spec ? [spec] : [])], {
    encoding: "utf8", windowsHide: true, timeout: 120000, env: { ...process.env, PLUGIN_DATA: path.join(output, "state") }
  });
  if (proc.error || proc.status !== 0) return { error: proc.error?.message || proc.stderr, exitCode: proc.status };
  return JSON.parse(fs.readFileSync(destination, "utf8"));
};
for (const item of definitions) {
  const original = path.join(root, "new-holdouts", item.repo);
  assert.equal(git(original, "status", "--porcelain"), "");
  const directory = path.join(output, item.repo), copy = path.join(directory, "copy");
  fs.mkdirSync(copy, { recursive: true });
  const archive = path.join(directory, "source.tar");
  git(original, "archive", "--format=tar", "-o", archive, "HEAD");
  execFileSync("tar", ["-xf", archive, "-C", copy], { windowsHide: true });
  git(copy, "init", "--quiet"); git(copy, "config", "core.autocrlf", "false"); git(copy, "add", "-A");
  git(copy, "-c", "user.name=FlowGuard Benchmark", "-c", "user.email=benchmark@flowguard.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Upstream evaluation snapshot");
  const spec = path.join(directory, "case.json"), blueprint = path.join(directory, "blueprint.json");
  write(spec, { ...item, changes: [{ file: item.file }] });
  assert.ok(runWorker(copy, blueprint, "blueprint", spec).wiringPlan);
  const target = path.join(copy, item.file), originalBytes = fs.readFileSync(target), source = originalBytes.toString("utf8").replace(/\r\n/g, "\n");
  for (const variant of ["control", "defect"]) {
    const variantDir = path.join(directory, variant); fs.mkdirSync(variantDir);
    try {
      const edited = item.edit(source, variant === "defect"); assert.notEqual(edited, source);
      fs.writeFileSync(target, edited);
      fs.writeFileSync(path.join(variantDir, "change.patch"), git(copy, "diff", "--no-ext-diff", "--no-color"));
      const [command, args] = item.probe(copy, variantDir);
      const probe = spawnSync(command, args, { cwd: variantDir, encoding: "utf8", windowsHide: true, timeout: 60000 });
      const behavior = { command, args, exitCode: probe.status, stdout: probe.stdout, stderr: probe.stderr, error: probe.error?.message };
      write(path.join(variantDir, "behavior.json"), behavior);
      assert.ok(!probe.error && probe.status !== null, "Behavior probe infrastructure must succeed");
      assert.equal(probe.status === 0, variant === "control", `${item.repo}: behavior ground truth`);
      const scans = {};
      for (const mode of ["full", "incremental", "planned"]) {
        const scan = runWorker(copy, path.join(variantDir, `${mode}.json`), mode === "full" ? "full" : "incremental", mode === "planned" ? blueprint : undefined);
        if (scan.error) { scans[mode] = scan; continue; }
        const report = scan.report;
        const relevant = report.wiringReport.obligations.filter((o) => o.checkSpec?.targetSymbol === item.symbol || o.targetLocation?.includes(item.symbol));
        scans[mode] = { verdict: report.verificationVerdict,
          targetedBlock: relevant.some((o) => o.status === "VIOLATED"),
          diagnostic: report.dataFlowBreaks.some((d) => d.location?.includes(item.symbol) && d.unusedParams?.includes(item.param)),
          relevant: relevant.map((o) => ({ layer: o.layer, status: o.status, finding: o.finding })) };
      }
      const result = { repo: item.repo, symbol: item.symbol, param: item.param, variant, behaviorPassed: probe.status === 0, scans };
      results.push(result); write(path.join(output, "results.json"), results); console.log(JSON.stringify(result));
    } finally { fs.writeFileSync(target, originalBytes); }
  }
  provenance.push({ repo: item.repo, original, copy, commit: git(original, "rev-parse", "HEAD"), originalStatus: git(original, "status", "--porcelain"), copyStatus: git(copy, "status", "--porcelain") });
}
write(path.join(output, "provenance.json"), provenance);
write(path.join(output, "engine.json"), JSON.parse(fs.readFileSync(path.join(root, scanRun, "manifest.json"), "utf8")).engine);
