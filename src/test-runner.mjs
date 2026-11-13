import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeScopedState } from "./state-store.mjs";

export function runBehavioralTest(workspaceRoot, options) {
  const timeout = options.testTimeoutMs ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000) throw new Error("testTimeoutMs must be 1..3600000");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-process.mjs", import.meta.url)),
    JSON.stringify({ command: options.runTestsCommand, cwd: workspaceRoot, timeout, maxBytes: 1024 * 1024 })], {
    cwd: workspaceRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true
  });
  let details;
  try {
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    details = JSON.parse(result.stdout);
  } catch (err) {
    details = { outcome: "EXECUTION_ERROR", exitCode: result.status, signal: result.signal,
      errorCode: result.error?.code || "RUNNER_ERROR", message: err.message, stdout: "", stderr: result.stderr || "" };
  }
  const execution = {
    runId: crypto.randomUUID(), command: options.runTestsCommand, cwd: workspaceRoot,
    startedAt, durationMs: Math.round(performance.now() - started), ...details
  };
  try {
    execution.artifactPath = writeScopedState(`test-run-${execution.runId}`, workspaceRoot, execution, options);
  } catch (err) {
    execution.artifactError = err.message;
  }
  return { ...execution, stdout: execution.stdout.slice(-4096), stderr: execution.stderr.slice(-4096) };
}
