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
      "【全局架构视野】扫描代码仓库的子系统分层拓扑（architectureDomains）、Top 8 端到端主干因果动脉（backbonePipelines）、高中心度枢纽符号（architecturalHubs）、多态继承与预留契约目录（extensionAndReserveCatalog）、跨语言桥接与状态唯一写入权（SSOT）。",
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
        }
      }
    }
  },
  {
    name: "flow_trace",
    description:
      "【改代码前必调】输入任意函数名、类名、文件名或状态字段，透视其所属架构域与签名、修改爆炸半径评估（blastRadius）、入参消费与预留契约矩阵（parameterFlowMatrix）、多态同族实现（polymorphicPeers）、上下游完整因果水路、同级分流支路（防改A漏B）及可复用近似函数。",
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
        }
      },
      required: ["target"]
    }
  },
  {
    name: "flow_blueprint",
    description:
      "【新功能/隔离实验代码接入生产前必调】指定参考模块名，生成架构定位档案（所属域、容器继承、公开 API 面、同族可对标实现 peerImplementations、预留签名契约）及四站式施工单（1.构造与注册表挂载 ➔ 2.上游分流入口 ➔ 3.成对对称契约 ➔ 4.下游真实终端与状态落点）。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "代码仓库根目录绝对路径"
        },
        reference: {
          type: "string",
          description: "参考的现有同类模块名、类名或文件名"
        }
      },
      required: ["reference"]
    }
  },
  {
    name: "flow_verify",
    description:
      "【改完代码交卷前必调】执行端到端通水试验与增量审计：精准区分“预留扩展点/多态对齐/条件编译契约（reservedContracts，严禁误删改签名）”与“真实孤立断流（dataFlowBreaks）/ 零水流死代码废管（unwiredOrDeadPipes）”，并检测跨语言断链、沙盒反向泄漏、只写死水状态与重复造轮子。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "代码仓库根目录绝对路径"
        },
        fullScan: {
          type: "boolean",
          description: "是否强制执行全仓扫描（默认在 Git 工作区存在变更时仅增量审计变更的源码文件）"
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
      return generateFlowOverview(root, Boolean(args.syncToAgentsMd));
    case "flow_trace":
      return traceSymbolFlow(root, args.target);
    case "flow_blueprint":
      return generateWiringBlueprint(root, args.reference);
    case "flow_verify":
      return verifyWorkspaceFlow(root, { fullScan: Boolean(args.fullScan) });
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
        serverInfo: { name: "flow-guard", version: "0.1.1" }
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
    const positional = rawRest.filter((arg) => arg !== "--full");
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
