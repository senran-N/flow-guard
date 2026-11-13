// Run the actual upstream CookiesStore with deterministic timers and explicit
// dependency substitutes; no Electron installation, disk writes or real delay.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [rootArg, corpusArg, phase = "phase6"] = process.argv.slice(2);
const root = path.resolve(rootArg), corpus = path.resolve(corpusArg);
assert.match(phase, /^phase\d+$/);
const output = path.join(root, `timer-behavior-${phase}`);
assert.ok(!fs.existsSync(output), "Evidence must not be overwritten");
fs.mkdirSync(output);
const repo = path.join(corpus, "bruno");
const relative = "packages/bruno-electron/src/store/cookies.js";
const original = fs.readFileSync(path.join(repo, relative), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const initialStatus = git("status", "--porcelain");
const engine = path.join(root, `${phase}-corpus`, "engine-snapshot", "src");
const manifest = JSON.parse(fs.readFileSync(path.join(root, `${phase}-corpus`, "manifest.json"), "utf8"));
const { verifyWorkspaceFlow } = await import(pathToFileURL(path.join(engine, "flow-verifier.mjs")));
const { generateWiringBlueprint } = await import(pathToFileURL(path.join(engine, "flow-tools.mjs")));

function execute(source) {
  const pending = new Map();
  let nextId = 0, writes = 0, error = null;
  const context = {
    module: { exports: {} }, console,
    require(name) {
      if (name === "electron-store") return class Store { get() {} set() {} };
      if (name === "@usebruno/requests") return { cookies: { cookieJar: { serializeSync: () => ({ cookies: [] }) }, createCookieString() {} } };
      if (name === "tough-cookie") return { Cookie: class Cookie {} };
      if (name === "crypto") return crypto;
      if (name === "../utils/encryption") return { encryptString: (s) => s, decryptString: (s) => s };
      throw new Error(`Unexpected dependency ${name}`);
    },
    setTimeout(callback) { const id = ++nextId; pending.set(id, callback); return id; },
    clearTimeout(id) { pending.delete(id); }
  };
  try {
    vm.runInNewContext(source, context, { filename: relative, timeout: 2000 });
    const store = new context.module.exports.CookiesStore();
    store.writeCookieJar = () => { writes++; };
    for (let i = 0; i < 3; i++) store.saveCookieJar();
    assert.equal(pending.size, 1, "A burst must retain only one scheduled write");
    for (const [id, callback] of [...pending]) { pending.delete(id); callback(); }
    assert.equal(writes, 1, "A burst must produce one write");
    store.saveCookieJar();
    store.saveCookieJar(true);
    assert.equal(pending.size, 0, "Immediate save must cancel the pending write");
    assert.equal(writes, 2);
  } catch (e) { error = e.stack; }
  return { passed: !error, writes, pending: pending.size, error };
}

assert.equal(original.split("clearTimeout(this.#saveTimerId);").length - 1, 2);
const results = [];
for (const variant of ["control", "defect"]) {
  const workspace = path.join(output, variant); fs.mkdirSync(workspace);
  const replacement = variant === "control" ? "clearTimeout((this.#saveTimerId));" : "clearTimeout(null);";
  const source = original.replaceAll("clearTimeout(this.#saveTimerId);", replacement);
  fs.writeFileSync(path.join(workspace, "cookies.js"), source);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "cookie-behavior-probe", main: "cookies.js" }));
  const behavior = execute(source);
  const blueprint = generateWiringBlueprint(workspace, "cookies.js", { targetField: "#saveTimerId", savePlan: false, requirePersistence: "not_required" });
  const report = verifyWorkspaceFlow(workspace, { fullScan: true, ignoreSavedPlan: true, wiringPlan: blueprint.wiringPlan });
  const target = report.wiringReport.obligations.find((o) => o.checkSpec?.type === "TARGET_DATA_CONSUMPTION");
  fs.writeFileSync(path.join(workspace, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(workspace, "probe.json"), JSON.stringify({ engineHash: manifest.engine.sourceHash, variant, behavior, target }, null, 2));
  assert.equal(behavior.passed, variant === "control");
  assert.equal(target.status, variant === "control" ? "SATISFIED" : "VIOLATED");
  results.push({ variant, behavior, target, analyzedScope: "upstream CookiesStore source module in isolated workspace" });
}
assert.equal(git("status", "--porcelain"), initialStatus);
assert.equal(fs.readFileSync(path.join(repo, relative), "utf8"), original);
const evidence = { engineHash: manifest.engine.sourceHash, repository: repo, commit: git("rev-parse", "HEAD"),
  originalSourceSha256: crypto.createHash("sha256").update(original).digest("hex"), file: relative, results,
  limitation: "Timers and external dependencies are substituted. This verifies cancellation/coalescing behavior, not Electron integration, encryption or persistence I/O." };
fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ output, results: results.map((r) => ({ variant: r.variant, behaviorPassed: r.behavior.passed, status: r.target.status })) }));
