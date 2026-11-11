#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateFlowOverview,
  traceSymbolFlow,
  generateWiringBlueprint
} from "./flow-tools.mjs";
import { verifyWorkspaceFlow } from "./flow-verifier.mjs";

const TOOLS = [
  {
    name: "flow_overview",
    description:
      "【全局架构视野】扫描代码仓库的项目模式（application/library/hybrid）、子系统分层拓扑（architectureDomains）、主干因果动脉（backbonePipelines）、高中心度枢纽符号（architecturalHubs）、多态与预留契约目录、跨语言桥接与状态唯一写入权（SSOT）。支持保存任务初始水路基线快照。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "代码仓库根目录绝对路径"
        },
        syncToAgentsMd: {
          type: "boolean",
          description: "是否将最新端到端水路 Mermaid 图写入 AGENTS.md 的 <!-- FLOWGUARD:START --> 块中"
        },
        saveBaseline: {
          type: "boolean",
          description: "是否将当前水路图保存为本次任务的初始基线快照（供后续跨多次修改的增量图差异验收使用）"
        },
        projectMode: {
          type: "string",
          enum: ["auto", "application", "library", "hybrid"],
          description: "覆盖工程模式判定（默认 auto 自动从 manifest 与运行入口识别）"
        }
      }
    }
  },
  {
    name: "flow_trace",
    description:
      "【改代码前必调】输入任意函数名、类名、文件名或状态字段，透视带源码行号与置信度证据的有向关系（evidencedRelations：区分 CONTAINS / SEQ_CALL / BRANCH_DISPATCH / REGISTRATION / STATE_RW / IMPLEMENTS / PROTOCOL_BRIDGE）、同级条件分支与顺序职责步骤分离、入参消费矩阵、多态同族与归一化词法 Shingle 近似候选。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "代码仓库根目录绝对路径"
        },
        target: {
          type: "string",
          description: "要透视追踪的函数名、类名、状态字段名或文件名"
        },
        projectMode: {
          type: "string",
          enum: ["auto", "application", "library", "hybrid"],
          description: "覆盖工程模式判定（默认 auto）"
        }
      },
      required: ["target"]
    }
  },
  {
    name: "flow_blueprint",
    description:
      "【接新功能/改跨层链路前必调】指定参考模块或状态字段，生成架构定位档案、四站式接线位置，并持久化一份与 flow_verify 共享的可追踪接入目标清单（wiringPlan：含 L1 结构接通、L2 数据传递消费、Save⇄Load 对称恢复及待确认歧义项）。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "代码仓库根目录绝对路径"
        },
        reference: {
          type: "string",
          description: "参考的现有同类模块名、类名、状态字段名或文件名"
        },
        targetSymbol: {
          type: "string",
          description: "本次计划新增或接入的目标函数/类名（可选，传入后 flow_verify 将精确核验其入口与注册）"
        },
        targetField: {
          type: "string",
          description: "本次计划新增或打通的配置/协议字段名（可选，传入后 flow_verify 将核验该字段是否真正传入下游计算并对称持久化）"
        },
        consumerTarget: {
          type: "string",
          description: "预期消费 targetField 的核心业务计算函数或类名（可选，用于检测“已写入配置但过滤计算仍读旧常量”）"
        },
        requirePersistence: {
          type: "string",
          enum: ["auto", "required", "not_required"],
          description: "该特性是否要求跨重启保存与恢复（Save ⇄ Load），默认 auto 按参考模块契约推断"
        },
        savePlan: {
          type: "boolean",
          description: "是否持久化该接入清单供后续 flow_verify 自动对照验收（默认 true）"
        }
      },
      required: ["reference"]
    }
  },
  {
    name: "flow_verify",
    description:
      "【改完代码交卷前必调】基于共享接入目标清单（wiringPlan）与修改前后水路图差异（Graph Diff：含未修改文件的波及断流），按 L1 结构接通 / L2 数据生效 / L3 行为测试三层证据逐项给出 SATISFIED（满足）/ VIOLATED（违反）/ INCONCLUSIVE（证据不足待确认）三态结论。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "代码仓库根目录绝对路径"
        },
        fullScan: {
          type: "boolean",
          description: "是否强制执行全仓静态扫描（默认优先对比基线快照或 Git 增量图差异）"
        },
        baseRef: {
          type: "string",
          description: "指定对比的 Git 基线引用（如 HEAD、HEAD~1、main 或提交 SHA），支持跨多次提交的任务级图差异验收"
        },
        projectMode: {
          type: "string",
          enum: ["auto", "application", "library", "hybrid"],
          description: "覆盖工程模式判定（application 模式下未接入入口的新增 export 将判为 VIOLATED；library 模式下包公开导出判为合法入口）"
        },
        runTestsCommand: {
          type: "string",
          description: "可选测试命令（传入后将实际运行命令以闭环 L3 行为生效证据）"
        },
        clearPlan: {
          type: "boolean",
          description: "是否在本次验收前清除已保存的旧蓝图接入清单"
        }
      }
    }
  }
];

let initializedWorkspaceRoot = "";

export function resolveRoot(argRoot) {
  if (argRoot && fs.existsSync(argRoot)) return path.resolve(argRoot);
  if (initializedWorkspaceRoot && fs.existsSync(initializedWorkspaceRoot)) {
    return path.resolve(initializedWorkspaceRoot);
  }
  const candidateDirs = [process.env.PLUGIN_DATA, os.tmpdir()].filter(Boolean);
  for (const dir of candidateDirs) {
    const cachePath = path.join(dir, "flowguard-last-workspace.txt");
    if (fs.existsSync(cachePath)) {
      const cached = fs.readFileSync(cachePath, "utf8").trim();
      if (cached && fs.existsSync(cached)) return path.resolve(cached);
    }
  }
  return process.cwd();
}

export function executeTool(name, args = {}) {
  const root = resolveRoot(args.workspaceRoot);
  switch (name) {
    case "flow_overview":
      return generateFlowOverview(root, Boolean(args.syncToAgentsMd), {
        saveBaseline: Boolean(args.saveBaseline),
        projectMode: args.projectMode
      });
    case "flow_trace":
      return traceSymbolFlow(root, args.target, {
        projectMode: args.projectMode
      });
    case "flow_blueprint":
      return generateWiringBlueprint(root, args.reference, {
        targetSymbol: args.targetSymbol,
        targetField: args.targetField,
        consumerTarget: args.consumerTarget,
        requirePersistence: args.requirePersistence,
        savePlan: args.savePlan,
        projectMode: args.projectMode
      });
    case "flow_verify":
      return verifyWorkspaceFlow(root, {
        fullScan: Boolean(args.fullScan),
        baseRef: args.baseRef,
        projectMode: args.projectMode,
        runTestsCommand: args.runTestsCommand,
        clearPlan: Boolean(args.clearPlan)
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

let useHeaderFraming = false;
let buffer = Buffer.alloc(0);

export function sendRpcResponse(msg) {
  const json = JSON.stringify(msg);
  if (useHeaderFraming) {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

export function handleRpcMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    const rawUri =
      params?.workspaceFolders?.[0]?.uri ||
      params?.rootUri ||
      params?.rootPath ||
      "";
    if (rawUri) {
      try {
        const parsedRoot = rawUri.startsWith("file://") ? fileURLToPath(rawUri) : rawUri;
        if (parsedRoot && fs.existsSync(parsedRoot)) {
          initializedWorkspaceRoot = path.resolve(parsedRoot);
        }
      } catch {
        initializedWorkspaceRoot = "";
      }
    }
    sendRpcResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "flow-guard", version: "0.2.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    sendRpcResponse({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    sendRpcResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const data = executeTool(params?.name, params?.arguments || {});
      sendRpcResponse({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
      });
    } catch (err) {
      sendRpcResponse({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `FlowGuard error: ${err.message}` }] }
      });
    }
    return;
  }
  if (id !== undefined) {
    sendRpcResponse({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  if (process.argv[2] === "--cli") {
    const rawName = process.argv[3] || "flow_overview";
    const toolMap = {
      overview: "flow_overview",
      trace: "flow_trace",
      blueprint: "flow_blueprint",
      verify: "flow_verify"
    };
    const toolName = toolMap[rawName] || rawName;
    const rawRest = process.argv.slice(4);
    const hasFullFlag = rawRest.includes("--full");
    let baseRefArg = undefined;
    const positional = [];
    for (let i = 0; i < rawRest.length; i++) {
      if (rawRest[i] === "--full") continue;
      if (rawRest[i] === "--base" && rawRest[i + 1]) {
        baseRefArg = rawRest[++i];
        continue;
      }
      positional.push(rawRest[i]);
    }
    let rawArgs = {};
    if (positional[0]) {
      if (positional[0].trim().startsWith("{")) {
        rawArgs = JSON.parse(positional[0]);
      } else {
        rawArgs = { workspaceRoot: positional[0] };
        if (positional[1]) {
          rawArgs.target = positional[1];
          rawArgs.reference = positional[1];
        }
      }
    }
    if (hasFullFlag) rawArgs.fullScan = true;
    if (baseRefArg) rawArgs.baseRef = baseRefArg;
    const result = executeTool(toolName, rawArgs);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const strPreview = buffer.slice(0, Math.min(buffer.length, 64)).toString("utf8");
      if (strPreview.startsWith("Content-Length:")) {
        useHeaderFraming = true;
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const headerStr = buffer.slice(0, headerEnd).toString("utf8");
        const m = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const len = parseInt(m[1], 10);
        const totalNeeded = headerEnd + 4 + len;
        if (buffer.length < totalNeeded) break;
        const bodyStr = buffer.slice(headerEnd + 4, totalNeeded).toString("utf8");
        buffer = buffer.slice(totalNeeded);
        handleRpcMessage(JSON.parse(bodyStr));
      } else {
        const nlIdx = buffer.indexOf("\n");
        if (nlIdx === -1) break;
        const lineStr = buffer.slice(0, nlIdx).toString("utf8").trim();
        buffer = buffer.slice(nlIdx + 1);
        if (lineStr) handleRpcMessage(JSON.parse(lineStr));
      }
    }
  });
}
