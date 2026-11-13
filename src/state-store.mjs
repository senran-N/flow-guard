import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export function getFlowGuardDataDir() {
  const dir = process.env.PLUGIN_DATA || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getWorkspaceKeyHash(workspaceRoot) {
  return crypto.createHash("sha1").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

export function resolveStateScope(workspaceRoot, options = {}) {
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    sessionId: String(options.sessionId || process.env.FLOWGUARD_SESSION_ID || "default"),
    taskId: String(options.taskId || process.env.FLOWGUARD_TASK_ID || "default")
  };
}

export function getScopedStatePath(kind, workspaceRoot, options = {}) {
  const scope = resolveStateScope(workspaceRoot, options);
  const suffix = scope.sessionId === "default" && scope.taskId === "default" ? ""
    : `-${crypto.createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 20)}`;
  return path.join(getFlowGuardDataDir(), `flowguard-${kind}-${getWorkspaceKeyHash(workspaceRoot)}${suffix}.json`);
}

function currentBranch(workspaceRoot) {
  if (!fs.existsSync(path.join(workspaceRoot, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

export function writeScopedState(kind, workspaceRoot, value, options = {}) {
  const destination = getScopedStatePath(kind, workspaceRoot, options);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const envelope = {
    schemaVersion: 2,
    scope: resolveStateScope(workspaceRoot, options),
    branch: currentBranch(workspaceRoot),
    createdAt: new Date().toISOString(),
    value
  };
  try {
    fs.writeFileSync(temporary, JSON.stringify(envelope), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}

export function readScopedState(kind, workspaceRoot, options = {}) {
  const file = getScopedStatePath(kind, workspaceRoot, options);
  if (!fs.existsSync(file)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    if (envelope.schemaVersion !== 2 || !envelope.value) throw new Error("unsupported state schema");
    if (JSON.stringify(envelope.scope) !== JSON.stringify(resolveStateScope(workspaceRoot, options))) {
      throw new Error("workspace/session/task mismatch");
    }
    const age = Date.now() - Date.parse(envelope.createdAt);
    if (!Number.isFinite(age) || age < -60000 || age > 7 * 24 * 3600 * 1000) throw new Error("expired or invalid timestamp");
    if (envelope.branch !== currentBranch(workspaceRoot)) throw new Error("Git branch changed");
    return envelope.value;
  } catch (err) {
    options.stateDiagnostics?.push({ kind, code: "IGNORED_INVALID_STATE", file, reason: err.message });
    return null;
  }
}
