#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateFlowOverview,
  traceSymbolFlow,
  generateWiringBlueprint
} from "./flow-tools.mjs";
import { verifyWorkspaceFlow } from "./flow-verifier.mjs";
import { createRpcInput } from "./rpc-input.mjs";

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
        },
        allowInconclusive: {
          type: "boolean",
          description: "仅允许 CLI 将 INCONCLUSIVE 以兼容性退出码 0 返回；报告状态仍为 INCONCLUSIVE，不能掩盖违反或执行错误"
        }
      }
    }
  }
];

for (const name of ['flow_overview', 'flow_trace']) {
  Object.assign(TOOLS.find(tool => tool.name === name).inputSchema.properties, {
    level: { type: 'string', enum: ['module', 'file', 'symbol'], description: '架构展开层级；overview 默认 module，trace 默认 symbol' },
    focus: { type: 'string', description: '架构节点 ID、模块目录、文件路径或唯一符号名；可用返回的 drillDown 参数逐层展开' },
    depth: { type: 'integer', minimum: 0, maximum: 5, description: '焦点周围关系跳数，默认 1；0 仅展示焦点范围' },
    direction: { type: 'string', enum: ['both', 'upstream', 'downstream'], description: '架构邻域查询方向，默认 both；不代表运行时可达性' },
    maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回节点数，默认 40' },
    maxEdges: { type: 'integer', minimum: 1, maximum: 2000, description: '最多返回关系数，默认 80；关系附证据和置信度' },
    nodeOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '稳定节点分页偏移量，默认 0；完整计数及省略量见 architecture.coverage' },
    edgeOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '当前节点页内的关系分页偏移量，默认 0；改变节点页后应重置' }
  });
}
for (const name of ['flow_overview', 'flow_trace']) Object.assign(TOOLS.find(t => t.name === name).inputSchema.properties, {
  includeTopology: { type: 'boolean', description: '返回全投影的依赖环、孤立节点和枢纽；不受 focus/分页截断' },
  impact: { type: 'boolean', description: '返回焦点的上下游依赖影响；高置信路径与仅候选路径分列' },
  impactLimit: { type: 'integer', minimum: 1, maximum: 1000, description: '每方向每类影响结果的上限，默认 100' },
  edgeScope: { type: 'string', enum: ['node-page', 'all-matched'], description: 'all-matched 可独立遍历全部匹配关系；页外端点返回 boundaryNodes' },
  expectedGraphId: { type: 'string', description: '翻页时传回 graphId，源码/配置/图变化时拒绝混用' },
  edgeId: { type: 'string', description: '要获取完整证据的关系 ID，需使用返回该关系时的 level' },
  evidenceOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '关系证据分页偏移量' },
  maxEvidence: { type: 'integer', minimum: 1, maximum: 500, description: '单次关系证据上限，默认 50' }
});
for (const name of ['flow_overview', 'flow_trace']) Object.assign(TOOLS.find(t => t.name === name).inputSchema.properties, {
  candidateOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '完整关系证据中的候选分页偏移量' },
  maxCandidates: { type: 'integer', minimum: 1, maximum: 200, description: '完整证据单页候选数，默认 20；预览最多 8 个' }
});
Object.assign(TOOLS.find(tool => tool.name === 'flow_overview').inputSchema.properties, {
  maxHops: { type: 'integer', minimum: 1, maximum: 50, description: '影响面跳数上限，默认 12' },
  baseRef: { type: 'string', description: '从 Git archive 重建历史源码/配置后比较架构，默认 file 层；需要 Git 和 tar' },
  diffLimit: { type: 'integer', minimum: 1, maximum: 1000, description: '每类架构变化的返回上限，默认 100，省略量另列' }
});

Object.assign(TOOLS.find(tool => tool.name === 'flow_trace').inputSchema.properties, {
  inspectState: { type: 'boolean', description: '将 target 作为精确状态字段/限定名查询写读所有者与持久化线索' },
  maxStates: { type: 'integer', minimum: 1, maximum: 200, description: '状态查询最多返回数，默认 20' },
  maxOwners: { type: 'integer', minimum: 1, maximum: 500, description: '每个状态最多返回的写入方/读取方，默认 30' },
  stateOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '状态查询分页偏移量' },
  to: { type: 'string', description: '路径终点：唯一符号、精确节点 ID、文件或模块；与 target 组成有向路径查询' },
  pathMode: { type: 'string', enum: ['execution', 'relationships'], description: 'execution 默认只走调用/协议；relationships 包含注册、状态、结构和依赖' },
  maxHops: { type: 'integer', minimum: 1, maximum: 50, description: '路径跳数上限，默认 12' },
  maxPaths: { type: 'integer', minimum: 1, maximum: 50, description: '返回最短简单路径数量上限，默认 5' },
  searchBudget: { type: 'integer', minimum: 1, maximum: 1000000, description: '路径搜索状态预算，默认 20000；截断会明确返回' },
  includeCandidates: { type: 'boolean', description: '路径是否包含候选边，默认 false' }
});

for (const tool of TOOLS) {
  Object.assign(tool.inputSchema.properties, {
    sessionId: { type: "string", description: "会话隔离标识；也可通过 FLOWGUARD_SESSION_ID 设置" },
    taskId: { type: "string", description: "同一会话内的任务隔离标识；也可通过 FLOWGUARD_TASK_ID 设置" }
  });
}
TOOLS.find((tool) => tool.name === "flow_verify").inputSchema.properties.testTimeoutMs = {
  type: "integer", minimum: 1, maximum: 3600000, description: "测试超时（毫秒），默认 60000；超时不等于测试断言失败"
};
Object.assign(TOOLS.find(tool => tool.name === 'flow_verify').inputSchema.properties, {
  rustSemantic: { type: 'boolean', description: '使用本机 rust-analyzer 补充 Rust 语义调用证据；要求 fullScan:true 且不传 baseRef' },
  rustBuildScripts: { type: 'boolean', description: '允许 Cargo 执行 build.rs 和过程宏以完成语义分析（默认 false；仅分析可信代码）' },
  rustFeatures: { type: 'string', description: '语义分析所选 Cargo features，逗号分隔' },
  rustNoDefaultFeatures: { type: 'boolean', description: '语义分析禁用默认 Cargo features' },
  rustTarget: { type: 'string', description: '语义分析所选 Rust target triple' },
  rustSemanticTimeoutMs: { type: 'integer', minimum: 1, maximum: 3600000, description: 'Rust 语义分析超时毫秒数，默认 120000' }
});

let initializedWorkspaceRoot = "";

export function resolveRoot(argRoot) {
  if (argRoot) {
    if (!fs.existsSync(argRoot) || !fs.statSync(argRoot).isDirectory()) throw new Error(`Invalid workspaceRoot: ${argRoot}`);
    return path.resolve(argRoot);
  }
  if (initializedWorkspaceRoot && fs.existsSync(initializedWorkspaceRoot)) {
    return path.resolve(initializedWorkspaceRoot);
  }
  return process.cwd();
}

export function executeTool(name, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object");
  const schema = TOOLS.find((tool) => tool.name === name)?.inputSchema;
  for (const key of schema?.required || []) {
    if (args[key] === undefined || (typeof args[key] === "string" && !args[key].trim())) throw new TypeError(`${key} is required`);
  }
  for (const [key, rule] of Object.entries(schema?.properties || {})) {
    const value = args[key];
    if (value === undefined) continue;
    const validType = rule.type === "integer" ? Number.isInteger(value) : typeof value === rule.type;
    if (!validType || (rule.enum && !rule.enum.includes(value)) ||
        (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)) {
      throw new TypeError(`Invalid ${key}: expected ${rule.type}${rule.enum ? ` (${rule.enum.join(", ")})` : ""}`);
    }
  }
  const root = resolveRoot(args.workspaceRoot);
  switch (name) {
    case "flow_overview":
      return generateFlowOverview(root, Boolean(args.syncToAgentsMd), {
        ...args,
        saveBaseline: Boolean(args.saveBaseline),
        projectMode: args.projectMode
      });
    case "flow_trace":
      return traceSymbolFlow(root, args.target, {
        ...args,
        projectMode: args.projectMode
      });
    case "flow_blueprint":
      return generateWiringBlueprint(root, args.reference, {
        ...args,
        targetSymbol: args.targetSymbol,
        targetField: args.targetField,
        consumerTarget: args.consumerTarget,
        requirePersistence: args.requirePersistence,
        savePlan: args.savePlan,
        projectMode: args.projectMode
      });
    case "flow_verify":
      return verifyWorkspaceFlow(root, {
        ...args,
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
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" ||
      typeof msg.method !== "string" || (msg.id !== undefined && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") ||
      (msg.params !== undefined && (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)))) {
    sendRpcResponse({ jsonrpc: "2.0", id: typeof msg?.id === "string" || typeof msg?.id === "number" ? msg.id : null,
      error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const { id, method, params } = msg;
  // A notification never expects a response or executes a request-only tool.
  if (id === undefined) return;

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
        protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(params?.protocolVersion)
          ? params.protocolVersion : "2025-11-25",
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
      const data = executeTool(params?.name, params?.arguments === undefined ? {} : params.arguments);
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

function parseCliArguments(toolName, tokens) {
  const valueFlags = {
    "--base": "baseRef",
    "--target": "targetSymbol",
    "--field": "targetField",
    "--consumer": "consumerTarget",
    "--run-tests": "runTestsCommand",
    "--candidate-offset": "candidateOffset", "--max-candidates": "maxCandidates",
    "--impact-limit": "impactLimit",
    "--edge-scope": "edgeScope", "--expected-graph": "expectedGraphId", "--edge-id": "edgeId", "--evidence-offset": "evidenceOffset", "--max-evidence": "maxEvidence",
    "--diff-limit": "diffLimit",
    "--max-states": "maxStates", "--max-owners": "maxOwners", "--state-offset": "stateOffset",
    "--to": "to", "--path-mode": "pathMode", "--max-hops": "maxHops", "--max-paths": "maxPaths", "--search-budget": "searchBudget",
    "--level": "level", "--focus": "focus", "--depth": "depth", "--direction": "direction",
    "--max-nodes": "maxNodes", "--max-edges": "maxEdges", "--node-offset": "nodeOffset", "--edge-offset": "edgeOffset",
    "--project-mode": "projectMode",
    "--session": "sessionId", "--task": "taskId", "--test-timeout": "testTimeoutMs",
    "--rust-features": "rustFeatures", "--rust-target": "rustTarget", "--rust-semantic-timeout": "rustSemanticTimeoutMs"
  };
  const booleanFlags = {
    "--topology": ["includeTopology", true], "--impact": ["impact", true],
    "--inspect-state": ["inspectState", true],
    "--include-candidates": ["includeCandidates", true],
    "--full": ["fullScan", true],
    "--persist": ["requirePersistence", "required"],
    "--allow-inconclusive": ["allowInconclusive", true],
    "--rust-semantic": ['rustSemantic', true], "--rust-build-scripts": ['rustBuildScripts', true],
    "--rust-no-default-features": ['rustNoDefaultFeatures', true]
  };
  const supportedFlags = {
    flow_overview: ["--base", "--diff-limit", "--max-hops", "--project-mode", "--level", "--focus", "--depth", "--direction", "--max-nodes", "--max-edges", "--node-offset", "--edge-offset", "--edge-scope", "--expected-graph", "--edge-id", "--evidence-offset", "--max-evidence", "--topology", "--impact", "--impact-limit", "--candidate-offset", "--max-candidates"],
    flow_trace: ["--inspect-state", "--max-states", "--max-owners", "--state-offset", "--to", "--path-mode", "--max-hops", "--max-paths", "--search-budget", "--include-candidates", "--project-mode", "--level", "--focus", "--depth", "--direction", "--max-nodes", "--max-edges", "--node-offset", "--edge-offset", "--edge-scope", "--expected-graph", "--edge-id", "--evidence-offset", "--max-evidence", "--topology", "--impact", "--impact-limit", "--candidate-offset", "--max-candidates"],
    flow_blueprint: ["--target", "--field", "--consumer", "--persist", "--project-mode"],
    flow_verify: ["--base", "--full", "--run-tests", "--project-mode", "--test-timeout", "--allow-inconclusive",
      '--rust-semantic', '--rust-build-scripts', '--rust-features', '--rust-no-default-features', '--rust-target', '--rust-semantic-timeout']
  };
  const positional = [];
  const overrides = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (!["--session", "--task"].includes(token) && !supportedFlags[toolName]?.includes(token)) throw new Error(`Unsupported option for ${toolName}: ${token}`);
    if (booleanFlags[token]) {
      const [key, value] = booleanFlags[token];
      overrides[key] = value;
    } else {
      const value = tokens[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      overrides[valueFlags[token]] = value;
    }
  }

  const usesJson = positional[0]?.trim().startsWith("{");
  if (positional.length > (usesJson || !["flow_trace", "flow_blueprint"].includes(toolName) ? 1 : 2)) {
    throw new Error("Too many positional arguments");
  }
  const args = usesJson ? JSON.parse(positional[0]) : {
    ...(positional[0] ? { workspaceRoot: positional[0] } : {}),
    ...(positional[1] ? { [toolName === "flow_blueprint" ? "reference" : "target"]: positional[1] } : {})
  };
  Object.assign(args, overrides);
  for (const key of ['depth', 'maxNodes', 'maxEdges', 'nodeOffset', 'edgeOffset', 'maxHops', 'maxPaths', 'searchBudget', 'maxStates', 'maxOwners', 'stateOffset', 'diffLimit', 'evidenceOffset', 'maxEvidence', 'impactLimit', 'candidateOffset', 'maxCandidates']) {
    if (overrides[key] !== undefined) args[key] = Number(overrides[key]);
  }
  if (args.testTimeoutMs !== undefined) args.testTimeoutMs = Number(args.testTimeoutMs);
  if (args.rustSemanticTimeoutMs !== undefined) args.rustSemanticTimeoutMs = Number(args.rustSemanticTimeoutMs);
  if (toolName === "flow_trace" && !args.target) throw new Error("flow_trace requires a target");
  if (toolName === "flow_blueprint" && !args.reference) throw new Error("flow_blueprint requires a reference");
  if (args.projectMode && !["auto", "application", "library", "hybrid"].includes(args.projectMode)) {
    throw new Error(`Invalid project mode: ${args.projectMode}`);
  }
  if (args.workspaceRoot && !fs.statSync(args.workspaceRoot).isDirectory()) throw new Error("workspaceRoot must be a directory");
  return args;
}

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
    try {
      const rawArgs = parseCliArguments(toolName, process.argv.slice(4));
      const result = executeTool(toolName, rawArgs);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exitCode = result.executionErrors?.length
        ? 2
        : toolName === "flow_verify" && (result.verificationVerdict === "VIOLATED" || result.status === "ISSUES_FOUND")
          ? 1
          : toolName === "flow_verify" && result.verificationVerdict === "INCONCLUSIVE"
            ? rawArgs.allowInconclusive === true ? 0 : 3
            : 0;
    } catch (err) {
      process.stderr.write(`FlowGuard CLI error: ${err.message}\n`);
      process.exitCode = 2;
    }
  } else {
    const input = createRpcInput({
      onMessage: handleRpcMessage,
      onParseError: () => sendRpcResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      onFraming: (header) => { useHeaderFraming = header; }
    });
    process.stdin.on("data", (chunk) => {
      try { input.write(chunk); }
      catch (error) {
        process.stderr.write(`FlowGuard transport error: ${error.message}\n`);
        process.exitCode = 2;
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", () => input.end());
  }
}
