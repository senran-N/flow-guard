import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(new URL("./real-world-worker.mjs", import.meta.url));
const [corpusArg = "D:/Myproject/crack", outputArg, repetitionsArg = "2", ...selectedNames] = process.argv.slice(2);
if (!outputArg) throw new Error("Usage: node benchmark/real-world-scan.mjs <corpus> <output-directory> [repetitions=2]");
const corpus = path.resolve(corpusArg);
const output = path.resolve(outputArg);
if (fs.existsSync(path.join(output, "manifest.json"))) throw new Error("Existing scan evidence is never overwritten; choose a new output directory");
const repetitions = Number(repetitionsArg);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("repetitions must be 1..5");
fs.mkdirSync(path.join(output, "scans"), { recursive: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const engineFiles = Object.fromEntries(fs.readdirSync(path.join(engineRoot, "src")).filter((f) => f.endsWith(".mjs")).sort()
  .map((f) => [f, hash(fs.readFileSync(path.join(engineRoot, "src", f)))]));
const repositories = fs.readdirSync(corpus, { withFileTypes: true }).filter((e) => e.isDirectory())
  .filter((e) => selectedNames.length === 0 || selectedNames.includes(e.name))
  .filter((e) => fs.existsSync(path.join(corpus, e.name, ".git"))).map((e) => {
    const workspace = path.join(corpus, e.name);
    return { name: e.name, workspace, commit: git(workspace, "rev-parse", "HEAD"),
      remote: git(workspace, "remote", "get-url", "origin"), initialStatus: git(workspace, "status", "--porcelain") };
  });
const manifest = { startedAt: new Date().toISOString(), corpus, output, repetitions,
  environment: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length },
  engine: { gitHead: git(engineRoot, "rev-parse", "HEAD"), sourceHash: hash(JSON.stringify(engineFiles)), files: engineFiles }, repositories };
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
// Every worker uses the same captured implementation, even if development resumes.
const engineSnapshot = path.join(output, "engine-snapshot");
fs.mkdirSync(path.join(engineSnapshot, "benchmark"), { recursive: true });
fs.cpSync(path.join(engineRoot, "src"), path.join(engineSnapshot, "src"), { recursive: true });
fs.copyFileSync(path.join(engineRoot, "package.json"), path.join(engineSnapshot, "package.json"));
fs.copyFileSync(worker, path.join(engineSnapshot, "benchmark", "real-world-worker.mjs"));
const frozenWorker = path.join(engineSnapshot, "benchmark", "real-world-worker.mjs");

const jobs = repositories.flatMap((repo) => Array.from({ length: repetitions }, (_, i) => ({ repo, run: i + 1 })));
const results = [];
let index = 0;
async function execute({ repo, run }) {
  const destination = path.join(output, "scans", `${repo.name}.${run}.json`);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [frozenWorker, repo.workspace, destination], {
      cwd: engineRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLUGIN_DATA: path.join(output, "state", `${repo.name}.${run}`) }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
        catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    }, 120000);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const record = { repository: repo.name, run, exitCode, signal, timedOut, elapsedMs: Date.now() - started, destination, stderr };
      if (fs.existsSync(destination)) {
        const data = JSON.parse(fs.readFileSync(destination, "utf8"));
        if (data.report) record.resultHash = hash(JSON.stringify({ graph: data.graph, report: data.report }));
      }
      console.log(stdout.trim() || JSON.stringify(record));
      resolve(record);
    });
  });
}
async function consume() {
  while (index < jobs.length) {
    const job = jobs[index++];
    results.push(await execute(job));
    fs.writeFileSync(path.join(output, "scan-runs.json"), JSON.stringify(results, null, 2));
  }
}
await Promise.all([consume(), consume()]);
const stability = repositories.map((repo) => {
  const runs = results.filter((r) => r.repository === repo.name).sort((a, b) => a.run - b.run);
  return { repository: repo.name, completed: runs.every((r) => r.exitCode === 0 && r.resultHash),
    deterministic: runs.length >= 2 ? runs.every((r) => r.resultHash && r.resultHash === runs[0].resultHash) : null,
    verifyMs: runs.map((r) => fs.existsSync(r.destination) ? JSON.parse(fs.readFileSync(r.destination, "utf8")).verifyMs : null),
    finalStatus: git(repo.workspace, "status", "--porcelain"),
    finalCommit: git(repo.workspace, "rev-parse", "HEAD") };
});
fs.writeFileSync(path.join(output, "stability.json"), JSON.stringify(stability, null, 2));
console.log(JSON.stringify({ finished: new Date().toISOString(), repositories: repositories.length,
  completed: stability.filter((r) => r.completed).length, deterministic: stability.filter((r) => r.deterministic).length }));
