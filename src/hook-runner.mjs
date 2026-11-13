#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateFlowOverview } from "./flow-tools.mjs";
import { verifyWorkspaceFlow } from "./flow-verifier.mjs";
import { readScopedState, writeScopedState } from "./state-store.mjs";

export function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function resolveHookWorkspace(payload) {
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    const p = payload.workspacePaths[0];
    if (p && fs.existsSync(p)) {
      const resolved = path.resolve(p);
      return resolved;
    }
  }
  return process.cwd();
}

export function runHook(mode, payload = {}) {
  const workspaceRoot = resolveHookWorkspace(payload);
  const scope = { sessionId: payload.sessionId || payload.conversationId, taskId: payload.taskId };

  if (mode === "session-start") {
    const overview = generateFlowOverview(workspaceRoot, false, { ...scope, saveBaseline: true });
    if (overview.zoneCounts.prodFiles === 0) {
      return {};
    }
    const bridgesText =
      overview.crossLanguageBridges
        .slice(0, 6)
        .map((b) => `${b.fromFile} --[${b.contract}]--> ${b.toFile || "MISSING"}`)
        .join("; ") || "无跨语言桥";

    const msg = [
      `[FlowGuard 端到端水路基线已就绪] 模式: ${overview.workspaceProfile.projectMode} | 生产文件: ${overview.zoneCounts.prodFiles} | 真实水源(Sources): ${overview.flowSummary.trueSourcesCount} | 分流阀(Branches): ${overview.flowSummary.branchRoutersCount} | 真实终端(Sinks): ${overview.flowSummary.trueSinksCount}。`,
      `核心跨界桥: ${bridgesText}。`,
      `会话: ${scope.sessionId || "default"}，任务: ${scope.taskId || "default"}；调用工具时使用相同 sessionId/taskId。提示: 改跨文件逻辑前调 flow_trace 透视带证据关系，接新模块前调 flow_blueprint 生成共享接入清单，收工前调 flow_verify 对照核验满足/违反/待确认。`
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
    if (String(process.env.FLOWGUARD_MODE || "").toLowerCase() === "advisory") {
      return { decision: "allow" };
    }

    const report = verifyWorkspaceFlow(workspaceRoot, scope);
    const hasIncrementalScope =
      report.changedFilesScanned.length > 0 || (report.impactedUntouchedFiles?.length || 0) > 0;

    if (hasIncrementalScope && report.status === "ISSUES_FOUND") {
      const blockingDataBreaks = (report.dataFlowBreaks || []).filter(
        (d) => d.kind === "DEAD_LOCAL_ASSIGNMENT" || d.kind === "IGNORED_PURE_CALL"
      );
      const violatedObligations = (report.wiringReport?.obligations || []).filter(
        (o) => o.status === "VIOLATED" && o.required !== false
      );

      const issues = [];
      if (violatedObligations.length > 0) {
        const topObl = violatedObligations[0];
        issues.push(
          `接入契约违反 (${report.wiringReport.counts.violated}/${report.wiringReport.counts.total}): ${topObl.finding}${topObl.remediation ? ` -> 修复方向: ${topObl.remediation}` : ""}`
        );
      }
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
              v: violatedObligations.map((o) => ({ t: o.targetLocation, f: o.finding })),
              b: report.brokenBridges,
              s: report.sandboxViolations,
              d: blockingDataBreaks,
              a: report.antiPatterns
            })
          )
          .digest("hex");

        const lastHash = readScopedState("stop", workspaceRoot, scope)?.stateHash || "";

        if (lastHash !== stateHash) {
          writeScopedState("stop", workspaceRoot, { stateHash }, scope);
          return {
            decision: "continue",
            reason: `【FlowGuard 通水验收拦截】检测到明确违反的必要链路契约（注：待确认项不阻断，切勿添加无意义假调用掩盖告警）：\n${issues.join("\n")}\n请补齐真实接入关系并调用 flow_verify 复核后再结束任务。`
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
