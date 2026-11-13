import { spawn, execFileSync } from "node:child_process";

// Isolated runner: the parent API stays synchronous, while this process can stop the entire test tree.
const config = JSON.parse(process.argv[2]);
const child = spawn(config.command, {
  cwd: config.cwd, shell: true, windowsHide: true,
  detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
});
let outcome = null;
let errorCode = null;
let message = null;
let totalBytes = 0;
const stdout = [];
const stderr = [];

function stopTree(reason) {
  if (outcome) return;
  outcome = reason;
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore", timeout: 5000
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch (err) {
    message = `Process-tree cleanup: ${err.message}`;
    child.kill("SIGKILL");
  }
}

const timer = setTimeout(() => stopTree("TIMED_OUT"), config.timeout);
function capture(target, chunk) {
  const remaining = Math.max(0, config.maxBytes - totalBytes);
  target.push(chunk.subarray(0, remaining));
  totalBytes += chunk.length;
  if (totalBytes > config.maxBytes) stopTree("OUTPUT_LIMIT");
}
child.stdout.on("data", (chunk) => capture(stdout, chunk));
child.stderr.on("data", (chunk) => capture(stderr, chunk));
child.on("error", (err) => {
  outcome = "EXECUTION_ERROR";
  errorCode = err.code;
  message = err.message;
});
function decode(chunks) {
  const buffer = Buffer.concat(chunks);
  const utf8 = buffer.toString("utf8");
  return process.platform === "win32" && utf8.includes("\uFFFD")
    ? new TextDecoder("gb18030").decode(buffer) : utf8;
}
child.on("close", (exitCode, signal) => {
  clearTimeout(timer);
  const out = decode(stdout);
  const err = decode(stderr);
  const missingCommand = [126, 127, 9009].includes(exitCode)
    || (exitCode !== 0 && /not recognized as an internal or external command|不是内部或外部命令|command not found/i.test(err));
  outcome ||= missingCommand || signal ? "EXECUTION_ERROR" : exitCode === 0 ? "PASSED" : "TEST_FAILED";
  process.stdout.write(JSON.stringify({ outcome, exitCode, signal, errorCode, message, stdout: out, stderr: err }));
});
