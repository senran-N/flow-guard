#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateFlowOverview } from "./flow-tools.mjs";
import { verifyWorkspaceFlow } from "./flow-verifier.mjs";

function getCacheDir() {
  const pluginData = process.env.PLUGIN_DATA;
  if (pluginData) {
    try {
      fs.mkdirSync(pluginData, { recursive: true });
      return pluginData;
    } catch {
      return os.tmpdir();
    }
  }
  return os.tmpdir();
}

export function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function resolveHookWorkspace(payload) {
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    const p = payload.workspacePaths[0];
    if (p && fs.existsSync(p)) {
      const resolved = path.resolve(p);
      const cacheDir = getCacheDir();
      fs.writeFileSync(path.join(cacheDir, "flowguard-last-workspace.txt"), resolved, "utf8");
      if (cacheDir !== os.tmpdir()) {
        fs.writeFileSync(path.join(os.tmpdir(), "flowguard-last-workspace.txt"), resolved, "utf8");
      }
      return resolved;
    }
  }
  return process.cwd();
}

export function runHook(mode, payload = {}) {
  const workspaceRoot = resolveHookWorkspace(payload);

  if (mode === "session-start") {
    const overview = generateFlowOverview(workspaceRoot, false);
    if (overview.zoneCounts.prodFiles === 0) {
      return {};
    }
    const bridgesText =
      overview.crossLanguageBridges
        .slice(0, 6)
        .map((b) => `${b.fromFile} --[${b.contract}]--> ${b.toFile || "MISSING"}`)
        .join("; ") || "无跨语言桥";

    const msg = [
      `[FlowGuard 端到端水路基线已就绪] 生产文件: ${overview.zoneCounts.prodFiles} | 真实水源(Sources): ${overview.flowSummary.trueSourcesCount} | 分流阀(Branches): ${overview.flowSummary.branchRoutersCount} | 真实终端(Sinks): ${overview.flowSummary.trueSinksCount}。`,
      `核心跨界桥: ${bridgesText}。`,
      `提示: 改跨文件逻辑前请调 flow_trace 透视水路，接新模块前请调 flow_blueprint 提取施工单。`
    ].join(" ");

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: msg
          }
        }
      ]
    };
  }

  if (mode === "stop") {
    if (payload.terminationReason && payload.terminationReason !== "NO_TOOL_CALL") {
      return { decision: "allow" };
    }

    const report = verifyWorkspaceFlow(workspaceRoot);
    if (report.changedFilesScanned.length > 0 && report.status === "ISSUES_FOUND") {
      const blockingDataBreaks = (report.dataFlowBreaks || []).filter(
        (d) => d.kind === "DEAD_LOCAL_ASSIGNMENT" || d.kind === "IGNORED_PURE_CALL"
      );
      const issues = [];
      if (report.brokenBridges.length > 0) {
        issues.push(`跨语言桥接断流: ${JSON.stringify(report.brokenBridges[0])}`);
      }
      if (report.sandboxViolations.length > 0) {
        issues.push(`生产区反向依赖实验/测试区: ${JSON.stringify(report.sandboxViolations[0])}`);
      }
      if (blockingDataBreaks.length > 0) {
        issues.push(`局部数据流断裂: ${JSON.stringify(blockingDataBreaks[0])}`);
      }
      if (report.antiPatterns.length > 0) {
        issues.push(`新增代码包含吞错/屏蔽警告反模式: ${JSON.stringify(report.antiPatterns[0])}`);
      }

      if (issues.length > 0) {
        const stateHash = crypto
          .createHash("sha1")
          .update(
            JSON.stringify({
              w: workspaceRoot,
              b: report.brokenBridges,
              s: report.sandboxViolations,
              d: blockingDataBreaks,
              a: report.antiPatterns
            })
          )
          .digest("hex");

        const cacheFile = path.join(getCacheDir(), `flowguard-stop-${payload.conversationId || "default"}.txt`);
        const lastHash = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf8").trim() : "";

        if (lastHash !== stateHash) {
          fs.writeFileSync(cacheFile, stateHash, "utf8");
          return {
            decision: "continue",
            reason: `【FlowGuard 通水验收拦截】检测到未闭合的链路问题：\n${issues.join("\n")}\n请立即修复或调用 flow_verify 核查后再结束任务。`
          };
        }
      }
    }
    return { decision: "allow" };
  }

  return {};
}

export function main() {
  const modeArg = process.argv[2] || "session-start";
  const inputPayload = readStdinJson();
  const hookResponse = runHook(modeArg, inputPayload);
  process.stdout.write(JSON.stringify(hookResponse) + "\n");
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main();
}
