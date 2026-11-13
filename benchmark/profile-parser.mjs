import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { EXT_LANG, IGNORE_DIRS } from "../src/lang-presets.mjs";
import { parseSourceFileContent } from "../src/file-parser.mjs";

const [workspace, destination, worker] = process.argv.slice(2);
if (!workspace || !destination) throw new Error("Usage: node benchmark/profile-parser.mjs <workspace> <output-jsonl>");
if (worker !== "--worker") {
  if (fs.existsSync(destination)) throw new Error("Existing profiling evidence must not be overwritten");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const child = spawn(process.execPath, ["--max-old-space-size=2048", fileURLToPath(import.meta.url), workspace, destination, "--worker"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", timedOut = false;
  child.stdout.pipe(process.stdout);
  child.stderr.on("data", (s) => { stderr += s; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
      catch { child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
  }, 120000);
  child.on("close", (exitCode, signal) => {
    clearTimeout(timer);
    fs.writeFileSync(`${destination}.status.json`, JSON.stringify({ exitCode, signal, timedOut, stderr }, null, 2));
    console.log(JSON.stringify({ workspace, exitCode, timedOut }));
  });
} else {
  const retained = [];
  const record = (r) => fs.appendFileSync(destination, JSON.stringify(r) + "\n");
  const start = performance.now();
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && EXT_LANG[path.extname(ent.name).toLowerCase()] && !/\.(?:d\.ts|min\.js|bundle\.js|wasm\.js)$/.test(ent.name)) {
        const rel = path.relative(workspace, full).replace(/\\/g, "/");
        const source = fs.readFileSync(full, "utf8"), t0 = performance.now();
        record({ phase: "start", file: rel, bytes: fs.statSync(full).size, rssMiB: Math.round(process.memoryUsage().rss / 1048576) });
        const parsed = parseSourceFileContent(source, rel);
        retained.push(parsed);
        record({ phase: "end", file: rel, ms: Math.round(performance.now() - t0), symbols: parsed?.symbols.length, rssMiB: Math.round(process.memoryUsage().rss / 1048576) });
      }
    }
  }
  walk(path.resolve(workspace));
  record({ phase: "done", files: retained.length, ms: Math.round(performance.now() - start) });
}
