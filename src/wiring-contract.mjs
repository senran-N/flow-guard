import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getFlowGuardDataDir, getWorkspaceKeyHash, isTelemetryOrAuditField } from "./graph-diff.mjs";

function getPlanFilePath(workspaceRoot) {
  return path.join(getFlowGuardDataDir(), `flowguard-plan-${getWorkspaceKeyHash(workspaceRoot)}.json`);
}

function formatSymLoc(sym) {
  if (!sym) return "";
  const label = sym.parentContainerName ? `${sym.parentContainerName}.${sym.name}` : sym.name;
  return `${sym.file}:${sym.startLine} (${label})`;
}

function normalizeFieldToken(name) {
  return String(name || "")
    .replace(/^#|^_+/, "")
    .replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
    .toLowerCase();
}

function isPersistenceOrSerializerSymbol(sym) {
  if (!sym) return false;
  if (sym.paired && (sym.paired.group.startsWith("Save/Load") || sym.paired.group.startsWith("Encode/Decode"))) {
    return true;
  }
  return /^(?:save|load|serialize|deserialize|toJSON|fromJSON|dump|restore|persist|hydrate|encode|decode|marshal|unmarshal|writeConfig|readConfig)/i.test(
    sym.name || ""
  );
}

function getExternalProdCallersOfContainer(graph, containerSym) {
  const callers = new Map();
  const memberIds = [containerSym.id];
  for (const s of graph.symbolById.values()) {
    if (s.parentContainerId === containerSym.id || (s.file === containerSym.file && s.parentContainerName === containerSym.name)) {
      if (s.isConstructor || s.name === "new" || s.name === "create" || s.kind === "method") {
        memberIds.push(s.id);
      }
    }
  }
  for (const targetId of memberIds) {
    for (const edge of graph.inEdgeDetails?.get(targetId) || []) {
      if (edge.kind === "CONTAINS" || edge.kind === "IMPLEMENTS" || edge.kind === "STATE_RW") continue;
      const caller = graph.symbolById.get(edge.fromId);
      if (!caller || caller.zone !== "prod") continue;
      if (caller.id === containerSym.id || caller.parentContainerId === containerSym.id) continue;
      if (caller.file === containerSym.file && caller.parentContainerName === containerSym.name) continue;
      callers.set(caller.id, { caller, edge });
    }
  }
  return Array.from(callers.values());
}

export function clearActiveWiringPlan(workspaceRoot) {
  const filePath = getPlanFilePath(workspaceRoot);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function saveActiveWiringPlan(workspaceRoot, plan) {
  try {
    fs.writeFileSync(getPlanFilePath(workspaceRoot), JSON.stringify(plan, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function loadActiveWiringPlan(workspaceRoot) {
  const filePath = getPlanFilePath(workspaceRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw && Array.isArray(raw.obligations)) return raw;
  } catch {
    return null;
  }
  return null;
}

export function buildAndSaveWiringPlan(graph, workspaceRoot, options = {}) {
  const {
    referenceQuery = "",
    referenceFile = "",
    fileSyms = [],
    containers = [],
    baseContracts = [],
    targetSymbol = null,
    targetField = null,
    consumerTarget = null,
    requirePersistence = "auto",
    savePlan = true
  } = options;

  const obligations = [];
  const ambiguitiesToConfirm = [];
  let seq = 1;
  const nextId = () => `OBL-${seq++}`;

  // Collect reference evidence: inbound callers, registrations, bridges, domain state consumers, and paired lifecycle hooks
  const refRegistrars = [];
  const refInboundCallers = [];
  const refBridges = [];
  const refPairedGroups = new Map();
  const refDomainConsumers = new Map();

  for (const baseName of baseContracts) {
    for (const peerSub of graph.subclassesByBase?.get(baseName) || []) {
      for (const { caller, edge } of getExternalProdCallersOfContainer(graph, peerSub)) {
        if (edge.kind === "REGISTRATION" || edge.kind === "BRANCH_DISPATCH" || /factory|registry|router|create|dispatch|build/i.test(caller.name)) {
          refRegistrars.push({
            caller: formatSymLoc(caller),
            callerName: caller.name,
            callerFile: caller.file,
            kind: edge.kind,
            peerName: peerSub.name,
            baseContract: baseName
          });
        }
      }
    }
  }

  for (const s of fileSyms) {
    for (const edge of graph.inEdgeDetails?.get(s.id) || []) {
      if (edge.kind === "CONTAINS" || edge.kind === "IMPLEMENTS" || edge.kind === "STATE_RW") continue;
      const caller = graph.symbolById.get(edge.fromId);
      if (!caller || caller.zone !== "prod" || caller.file === referenceFile) continue;
      if (s.kind === "class" || s.kind === "struct" || s.isConstructor || s.name === "new" || edge.kind === "REGISTRATION") {
        refRegistrars.push({
          caller: formatSymLoc(caller),
          callerName: caller.name,
          callerFile: caller.file,
          kind: edge.kind,
          peerName: s.name,
          baseContract: (s.baseTypes || [])[0] || null
        });
      } else {
        refInboundCallers.push({
          caller: formatSymLoc(caller),
          callerName: caller.name,
          callerFile: caller.file,
          calleeName: s.name,
          kind: edge.kind
        });
      }
    }

    if (s.paired) {
      if (!refPairedGroups.has(s.paired.group)) {
        refPairedGroups.set(s.paired.group, { left: [], right: [] });
      }
      refPairedGroups.get(s.paired.group)[s.paired.side].push(formatSymLoc(s));
    }

    for (const stKey of graph.stateKeysBySymbol?.get(s.id) || []) {
      const own = graph.stateOwnership.get(stKey);
      if (!own) continue;
      for (const rId of own.readers || []) {
        const rSym = graph.symbolById.get(rId);
        if (rSym && rSym.zone === "prod" && !isPersistenceOrSerializerSymbol(rSym)) {
          refDomainConsumers.set(rSym.id, formatSymLoc(rSym));
        }
      }
    }
  }

  for (const b of graph.crossBridges || []) {
    if (b.fromFile === referenceFile || b.toFile === referenceFile) {
      refBridges.push(b);
    }
  }

  const dedupRegistrars = Array.from(new Map(refRegistrars.map((r) => [r.caller, r])).values()).slice(0, 5);
  const dedupCallers = Array.from(new Map(refInboundCallers.map((c) => [c.caller, c])).values()).slice(0, 5);
  const inferredConsumers = Array.from(refDomainConsumers.values()).slice(0, 5);
  const isLibProject = graph.workspaceProfile?.projectMode === "library";

  // 1. ENTRY_WIRING (L1_STRUCTURAL)
  obligations.push({
    id: nextId(),
    station: "ENTRY_WIRING",
    layer: "L1_STRUCTURAL",
    required: true,
    targetLocation: targetSymbol
      ? `目标符号 ${targetSymbol}`
      : targetField
        ? `字段 ${targetField} 的写入入口`
        : `参照 ${referenceFile} 新增的目标实现`,
    reason: isLibProject
      ? "库模块新能力需通过包公开入口导出并具备明确调用契约"
      : "应用新功能必须连通真实运行入口（UI 事件 / IPC / 路由 / 主循环），仅在模块上加 export 不构成接入",
    expectedRelation:
      dedupCallers.length > 0
        ? `从上游入口或分发调用方（参考: ${dedupCallers.map((c) => c.caller).join("; ")}）建立实际调用边`
        : "建立从真实 Source 到目标符号/字段写入方的可达控制路径",
    sourceBasis: `参考模块 ${referenceFile} (${referenceQuery})`,
    verificationMethod: "L1 控制流可达性校验：核验 reachableFromRuntimeSource（应用模式）或包主入口导出链（库模式）",
    ambiguity: null,
    checkSpec: {
      type: "ENTRY_REACHABILITY",
      targetSymbol,
      targetField,
      referenceCallers: dedupCallers.map((c) => c.callerName)
    }
  });

  // 2. REGISTRATION_OR_DISPATCH (L1_STRUCTURAL) when reference has factory/registry/polymorphic peers
  if (dedupRegistrars.length > 0 || baseContracts.length > 0) {
    obligations.push({
      id: nextId(),
      station: "REGISTRATION_OR_DISPATCH",
      layer: "L1_STRUCTURAL",
      required: true,
      targetLocation:
        dedupRegistrars.length > 0
          ? dedupRegistrars.map((r) => r.caller).join(" | ")
          : `同族契约 [${baseContracts.join(", ")}] 的工厂或派发入口`,
      reason: "同族实现必须挂载到统一的工厂、路由表或条件分支派发器，否则运行期无法按模式/类型分流触发",
      expectedRelation: `为 ${targetSymbol || "新实现类/处理器"} 建立 REGISTRATION / BRANCH_DISPATCH 或构造引用关系`,
      sourceBasis:
        dedupRegistrars.length > 0
          ? `同族对标挂载证据: ${dedupRegistrars.map((r) => `${r.caller} ➔ ${r.peerName}`).join("; ")}`
          : `基类/接口契约: ${baseContracts.join(", ")}`,
      verificationMethod: "L1 注册与分支边核验：检查目标实现是否具备外部生产区的注册、分支派发或实例化入边",
      ambiguity: graph.workspaceProfile?.hasDynamicPluginLoading
        ? "仓库存在动态插件加载信号，若新实现由外部配置反射加载，静态注册边可能待确认"
        : null,
      checkSpec: {
        type: "FACTORY_OR_DISPATCH_REGISTRATION",
        targetSymbol,
        baseContracts,
        expectedRegistrarFiles: dedupRegistrars.map((r) => r.callerFile),
        expectedRegistrarNames: dedupRegistrars.map((r) => r.callerName)
      }
    });
  }

  // 3. PROTOCOL_COUNTERPART (L1_STRUCTURAL + L2_DATA_FLOW) when reference crosses language/IPC/HTTP boundary
  if (refBridges.length > 0) {
    const sampleBridges = refBridges
      .slice(0, 3)
      .map((b) => `${b.kind}:${b.contract} (${b.fromFile} ➔ ${b.toFile || "MISSING"})`)
      .join("; ");
    obligations.push({
      id: nextId(),
      station: "PROTOCOL_COUNTERPART",
      layer: targetField ? "L2_DATA_FLOW" : "L1_STRUCTURAL",
      required: true,
      targetLocation: refBridges
        .map((b) => (b.fromFile === referenceFile ? b.toFile : b.fromFile))
        .filter(Boolean)
        .slice(0, 3)
        .join(" | ") || referenceFile,
      reason: "跨进程/跨语言链路要求发送端与接收端契约及载荷字段双向对齐，防止前端传新字段而后端仍读旧字段",
      expectedRelation: targetField
        ? `跨界桥保持 CONNECTED，且载荷字段 "${targetField}" 在对端处理器中被实际接收与读取`
        : "跨界协议桥接两端均存在且无未决多候选歧义",
      sourceBasis: `参考跨界桥: ${sampleBridges}`,
      verificationMethod: "L1 桥接连通性 + L2 跨界载荷字段消费校验",
      ambiguity: null,
      checkSpec: {
        type: "BRIDGE_ALIGNMENT",
        targetSymbol,
        targetField,
        referenceBridgeKinds: Array.from(new Set(refBridges.map((b) => b.kind)))
      }
    });
  }

  // 4. DATA_FLOW_CONSUMPTION (L2_DATA_FLOW)
  obligations.push({
    id: nextId(),
    station: "DATA_FLOW_CONSUMPTION",
    layer: "L2_DATA_FLOW",
    required: true,
    targetLocation: consumerTarget
      ? `目标消费计算 ${consumerTarget}`
      : inferredConsumers.length > 0
        ? `业务计算消费者（参考: ${inferredConsumers.slice(0, 3).join("; ")}）`
        : "下游真实业务消费者 / Sink",
    reason:
      "控制路径可达不等于目标数据生效：必须确保输入参数或新增配置字段真正传入下游计算并影响结果，而非仅写入状态/仅保存却仍使用旧常量或丢弃返回值",
    expectedRelation: targetField
      ? `字段 "${targetField}" 被写入后，必须被非持久化的实际业务消费者${consumerTarget ? ` (${consumerTarget})` : ""}读取并参与计算（禁止仍读旧常量）`
      : `${targetSymbol || "目标实现"} 的入参在函数体内被消费，且产出的返回值/状态流向真实消费者而不被裸调丢弃`,
    sourceBasis: consumerTarget
      ? `显式指定目标消费者: ${consumerTarget}`
      : inferredConsumers.length > 0
        ? `参考模块现有状态消费者: ${inferredConsumers.slice(0, 3).join("; ")}`
        : `参考模块 ${referenceFile} 数据流契约`,
    verificationMethod:
      "L2 数据流校验：检查字段写读闭环（剔除纯 Save/Serialize 假读取）、目标消费者是否仍引用大写旧常量、形参消费与返回值承接",
    ambiguity:
      !consumerTarget && targetField && inferredConsumers.length > 1
        ? `参考模块存在多个候选业务消费者 (${inferredConsumers.slice(0, 3).join(", ")})，如需限定特定计算函数请传入 consumerTarget`
        : null,
    checkSpec: {
      type: "TARGET_DATA_CONSUMPTION",
      targetSymbol,
      targetField,
      consumerTarget,
      inferredConsumers
    }
  });

  if (!consumerTarget && targetField && inferredConsumers.length > 1) {
    ambiguitiesToConfirm.push({
      aspect: "DATA_CONSUMER_TARGET",
      question: `字段 "${targetField}" 应作用于哪个具体计算函数？（参考模块中发现多个消费者: ${inferredConsumers.slice(0, 3).join(", ")}）`,
      defaultAssumption: "默认要求至少一个非持久化的真实业务计算函数读取该字段"
    });
  }

  // 5. PAIRED_LIFECYCLE (L2_DATA_FLOW) when persistence/symmetry exists or is requested
  const hasRefSaveLoad = Array.from(refPairedGroups.keys()).some((g) => g.startsWith("Save/Load"));
  const hasAnyPaired = refPairedGroups.size > 0;
  if (requirePersistence !== "not_required" && (requirePersistence === "required" || hasAnyPaired || targetField)) {
    const isExplicitlyRequired = requirePersistence === "required" || hasAnyPaired;
    const pairedDesc = Array.from(refPairedGroups.entries())
      .map(([g, sides]) => `${g}: [${sides.left.join(", ")}] ⇄ [${sides.right.join(", ")}]`)
      .join("; ");

    if (!isExplicitlyRequired && targetField) {
      ambiguitiesToConfirm.push({
        aspect: "PERSISTENCE_SYMMETRY",
        question: `新增字段 "${targetField}" 是否需要跨重启持久化保存与恢复（Save ⇄ Load）？参考模块 ${referenceFile} 中未直接声明 Save/Load 方法。`,
        defaultAssumption: "若所在配置容器存在 Save/Load 对，则强制核验双向保存与恢复；否则标记为待确认提示"
      });
    }

    obligations.push({
      id: nextId(),
      station: "PAIRED_LIFECYCLE",
      layer: "L2_DATA_FLOW",
      required: isExplicitlyRequired,
      targetLocation: pairedDesc || `${referenceFile} 及其关联持久化/生命周期模块`,
      reason: "成对生命周期（Save/Load、Register/Unregister、Open/Close）必须双向闭合，防止“配置能保存但重启后未恢复”或资源泄漏",
      expectedRelation: targetField
        ? `若持久化保存读取了 "${targetField}"，加载恢复侧必须对称写回 "${targetField}"`
        : "成对接口左右两侧均齐备且字段级读写对称",
      sourceBasis: hasAnyPaired ? `参考模块成对契约: ${pairedDesc}` : `字段 "${targetField}" 生命周期完整性检查`,
      verificationMethod: "L1 成对符号检查 + L2 Save/Load 字段级恢复对称校验 (fieldLifecycleAsymmetries)",
      ambiguity: !isExplicitlyRequired ? "参考模块未检出显式 Save/Load，是否必需持久化取决于产品需求" : null,
      checkSpec: {
        type: "PAIRED_LIFECYCLE_SYMMETRY",
        targetSymbol,
        targetField,
        requirePersistence,
        hasRefSaveLoad
      }
    });
  }

  // 6. BEHAVIORAL_VERIFICATION (L3_BEHAVIORAL)
  obligations.push({
    id: nextId(),
    station: "BEHAVIORAL_VERIFICATION",
    layer: "L3_BEHAVIORAL",
    required: false,
    targetLocation: "自动化测试套件 / 链路运行探针",
    reason: "静态分析可证明结构与数据传递闭合，但线程同步、运行期分支取值与最终输出变化需由测试或探针提供 L3 行为生效证据",
    expectedRelation: `改变 ${targetField || targetSymbol || "新增输入"} 后，测试用例或运行探针验证预期输出按要求变化`,
    sourceBasis: "FlowGuard 三层证据准则 (L3 Behavioral)",
    verificationMethod: "检查 test 区对目标符号/字段的调用覆盖，或通过 runTestsCommand 实际执行测试命令验证",
    ambiguity: "未配置运行测试命令时，静态无测试覆盖将如实标记为 INCONCLUSIVE（待确认），不会伪装为已验证行为生效",
    checkSpec: {
      type: "BEHAVIORAL_TEST_EVIDENCE",
      targetSymbol,
      targetField,
      consumerTarget
    }
  });

  const pipelineParts = [
    `1.入口触发 (${targetSymbol || "Entry/UI/IPC"})`,
    ...(dedupRegistrars.length > 0 ? [`2.注册分流 (${dedupRegistrars[0].callerName})`] : []),
    ...(refBridges.length > 0 ? [`3.跨界协议 (${refBridges[0].kind})`] : []),
    `4.业务消费 (${consumerTarget || (inferredConsumers[0] ? inferredConsumers[0] : targetField || "Sink")})`,
    ...(requirePersistence === "required" || hasRefSaveLoad ? ["↕ 对称保存与恢复 (Save ⇄ Load)"] : [])
  ];

  const plan = {
    planId: `plan-${getWorkspaceKeyHash(workspaceRoot)}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    workspaceRoot: path.resolve(workspaceRoot),
    referenceModule: referenceFile,
    referenceQuery,
    taskSpec: {
      targetSymbol: targetSymbol || null,
      targetField: targetField || null,
      consumerTarget: consumerTarget || null,
      requirePersistence
    },
    causalPipelineGoal: pipelineParts.join(" ➔ "),
    obligations,
    ambiguitiesToConfirm
  };

  if (savePlan) {
    saveActiveWiringPlan(workspaceRoot, plan);
  }

  return plan;
}

function findMatchingProdSymbols(graph, queryName) {
  if (!queryName) return [];
  const qNorm = queryName.trim().toLowerCase();
  const exact = [];
  const partial = [];
  for (const s of graph.symbolById.values()) {
    if (s.zone !== "prod") continue;
    const qual = s.parentContainerName ? `${s.parentContainerName}.${s.name}`.toLowerCase() : s.name.toLowerCase();
    const sLow = s.name.toLowerCase();
    if (sLow === qNorm || qual === qNorm) exact.push(s);
    else if (qual.includes(qNorm) || s.file.toLowerCase().includes(qNorm)) partial.push(s);
  }
  return exact.length > 0 ? exact : partial;
}

function findMatchingStateEntries(graph, targetField) {
  if (!targetField) return [];
  const normTarget = normalizeFieldToken(targetField);
  const matches = [];
  for (const own of graph.stateOwnership.values()) {
    if (
      normalizeFieldToken(own.field) === normTarget ||
      normalizeFieldToken(own.qualifiedField) === normTarget ||
      own.qualifiedField.toLowerCase() === targetField.trim().toLowerCase()
    ) {
      matches.push(own);
    }
  }
  return matches;
}

function evaluateSinglePlanObligation(obl, graph, flowDiff, options = {}) {
  const spec = obl.checkSpec || {};
  const profile = graph.workspaceProfile || { projectMode: "hybrid" };

  if (spec.type === "ENTRY_REACHABILITY") {
    if (spec.targetSymbol) {
      const targets = findMatchingProdSymbols(graph, spec.targetSymbol);
      if (targets.length === 0) {
        return {
          ...obl,
          status: "VIOLATED",
          evidence: [],
          finding: `未在生产区找到目标符号 "${spec.targetSymbol}"（尚未实现或命名不匹配）`,
          remediation: `请实现 "${spec.targetSymbol}" 并从真实入口${spec.referenceCallers?.length ? `（如 ${spec.referenceCallers.join(", ")}）` : ""}接入调用。`
        };
      }
      const wiredTargets = targets.filter((t) => {
        if (profile.projectMode === "library") {
          return graph.reachableFromSource.has(t.id) || t.isPackageEntryExport || t.isPublicApi;
        }
        if (t.kind === "class" || t.kind === "struct") {
          return getExternalProdCallersOfContainer(graph, t).length > 0 || graph.reachableFromRuntimeSource.has(t.id);
        }
        return graph.reachableFromRuntimeSource.has(t.id) || (graph.callInEdges.get(t.id)?.size || 0) > 0;
      });
      if (wiredTargets.length > 0) {
        const callers = wiredTargets
          .flatMap((t) => Array.from(graph.callInEdges.get(t.id) || []).map((id) => formatSymLoc(graph.symbolById.get(id))))
          .filter(Boolean)
          .slice(0, 4);
        return {
          ...obl,
          status: "SATISFIED",
          evidence: wiredTargets.map(formatSymLoc).concat(callers.map((c) => `caller: ${c}`)),
          finding: `目标符号 "${spec.targetSymbol}" 已连通生产控制流入口`,
          remediation: null
        };
      }
      if (profile.hasDynamicPluginLoading && targets.some((t) => t.isPublicApi)) {
        return {
          ...obl,
          status: "INCONCLUSIVE",
          evidence: targets.map(formatSymLoc),
          finding: `目标符号 "${spec.targetSymbol}" 已导出但未发现仓内静态调用方；因仓库含动态插件加载机制，需确认宿主加载配置`,
          remediation: `请核实插件宿主配置是否已注册 "${spec.targetSymbol}"，或补充静态入口调用。`
        };
      }
      return {
        ...obl,
        status: "VIOLATED",
        evidence: targets.map(formatSymLoc),
        finding: `目标符号 "${spec.targetSymbol}" 已定义${targets.some((t) => t.isPublicApi) ? "并导出" : ""}，但在应用中无任何真实生产入口可达路径`,
        remediation: `请从真实上游入口${spec.referenceCallers?.length ? `（参考: ${spec.referenceCallers.join(", ")}）` : ""}建立对 "${spec.targetSymbol}" 的调用关系，切勿仅靠添加 export 或构造无意义假调用敷衍。`
      };
    }

    if (spec.targetField) {
      const states = findMatchingStateEntries(graph, spec.targetField);
      const reachableWriters = states
        .flatMap((st) => st.writers.map((id) => graph.symbolById.get(id)))
        .filter((w) => w && (graph.reachableFromRuntimeSource.has(w.id) || graph.reachableFromSource.has(w.id)));
      if (reachableWriters.length > 0) {
        return {
          ...obl,
          status: "SATISFIED",
          evidence: reachableWriters.map(formatSymLoc),
          finding: `字段 "${spec.targetField}" 具备可达的生产写入入口 (${reachableWriters.map((w) => w.name).join(", ")})`,
          remediation: null
        };
      }
      return {
        ...obl,
        status: "VIOLATED",
        evidence: states.flatMap((st) => st.writers.map((id) => formatSymLoc(graph.symbolById.get(id)))).filter(Boolean),
        finding:
          states.length === 0 || states.every((st) => st.writers.length === 0)
            ? `未发现任何生产代码写入目标字段 "${spec.targetField}"`
            : `字段 "${spec.targetField}" 的写入函数未连通任何真实上游入口`,
        remediation: `请接通从界面输入/配置协议到字段 "${spec.targetField}" 写入方的调用链路。`
      };
    }

    const unwiredNew = (flowDiff?.newlyAddedUnwired || []).filter((u) => u.verdict === "VIOLATED");
    if (unwiredNew.length > 0) {
      return {
        ...obl,
        status: "VIOLATED",
        evidence: unwiredNew.map((u) => u.symbol),
        finding: unwiredNew[0].diagnosis,
        remediation: "请将新增实现挂载到真实上游分流入口，不要留下无入口孤岛函数。"
      };
    }
    return {
      ...obl,
      status: "SATISFIED",
      evidence: (flowDiff?.addedSymbols || []).slice(0, 4),
      finding: "当前生产入口连通性核验通过",
      remediation: null
    };
  }

  if (spec.type === "FACTORY_OR_DISPATCH_REGISTRATION") {
    const candidates = spec.targetSymbol
      ? findMatchingProdSymbols(graph, spec.targetSymbol)
      : (spec.baseContracts || [])
          .flatMap((b) => graph.subclassesByBase?.get(b) || [])
          .filter((s) => !obl.sourceBasis.includes(s.file));

    if (spec.targetSymbol && candidates.length === 0) {
      return {
        ...obl,
        status: "VIOLATED",
        evidence: [],
        finding: `未找到待注册的目标实现 "${spec.targetSymbol}"`,
        remediation: `请创建 "${spec.targetSymbol}" 并在 [${(spec.expectedRegistrarNames || []).join(", ") || "工厂/分发器"}] 中完成注册。`
      };
    }

    for (const cand of candidates) {
      const extCallers =
        cand.kind === "class" || cand.kind === "struct"
          ? getExternalProdCallersOfContainer(graph, cand)
          : Array.from(graph.callInEdges.get(cand.id) || [])
              .map((id) => graph.symbolById.get(id))
              .filter((c) => c && c.zone === "prod" && c.file !== cand.file)
              .map((caller) => ({ caller }));

      if (extCallers.length === 0) {
        if (cand.isFeatureGated || profile.hasDynamicPluginLoading) {
          return {
            ...obl,
            status: "INCONCLUSIVE",
            evidence: [formatSymLoc(cand)],
            finding: `实现 "${cand.name}" 未检出静态工厂注册边，但存在条件编译或动态加载特征，待确认运行期装载配置`,
            remediation: `请确认 "${cand.name}" 是否已写入插件清单或对应平台编译配置。`
          };
        }
        return {
          ...obl,
          status: "VIOLATED",
          evidence: [formatSymLoc(cand)],
          finding: `违反：新实现 "${cand.name}" 未加入工厂或分流注册点 [${(spec.expectedRegistrarNames || []).join(", ") || "分发器"}]`,
          remediation: `请在 ${(spec.expectedRegistrarFiles || []).join(" / ") || "对应工厂注册表"} 中为 "${cand.name}" 建立构造或分流派发分支。`
        };
      }
    }

    return {
      ...obl,
      status: "SATISFIED",
      evidence: candidates.map(formatSymLoc),
      finding: "目标实现已完成外部工厂/分发器挂载",
      remediation: null
    };
  }

  if (spec.type === "BRIDGE_ALIGNMENT") {
    const broken = (flowDiff ? flowDiff.newlyBrokenBridges : graph.crossBridges.filter((b) => b.status !== "CONNECTED")) || [];
    if (broken.length > 0) {
      return {
        ...obl,
        status: "VIOLATED",
        evidence: broken.map((b) => `${b.fromFile} --[${b.contract}]--> ${b.status}`),
        finding: `跨界协议断链或存在歧义 (${broken[0].contract}: ${broken[0].status})`,
        remediation: "请对齐跨语言命令名/路由路径/RPC 方法签名，确保桥接状态为 CONNECTED。"
      };
    }

    if (spec.targetField) {
      const drift = (flowDiff?.bridgePayloadDiffs || []).find((d) =>
        d.unconsumedByBackend.some((f) => normalizeFieldToken(f) === normalizeFieldToken(spec.targetField))
      );
      if (drift) {
        return {
          ...obl,
          status: "VIOLATED",
          evidence: [`${drift.from} ➔ ${drift.to}`],
          finding: drift.diagnosis,
          remediation: `请在对端处理器 ${drift.to} 中接收并读取字段 "${spec.targetField}"，替换遗留旧字段。`
        };
      }
    }

    return {
      ...obl,
      status: "SATISFIED",
      evidence: (graph.crossBridges || [])
        .filter((b) => b.status === "CONNECTED")
        .slice(0, 3)
        .map((b) => `${b.kind}:${b.contract}`),
      finding: "跨界协议桥接与载荷字段核验通过",
      remediation: null
    };
  }

  if (spec.type === "TARGET_DATA_CONSUMPTION") {
    if (spec.targetField) {
      const states = findMatchingStateEntries(graph, spec.targetField);
      const allReaders = states
        .flatMap((st) => st.readers.map((id) => graph.symbolById.get(id)))
        .filter((s) => s && s.zone === "prod");
      const domainReaders = allReaders.filter((s) => !isPersistenceOrSerializerSymbol(s));
      const persistenceOnlyReaders = allReaders.filter((s) => isPersistenceOrSerializerSymbol(s));

      if (spec.consumerTarget) {
        const consumerSyms = findMatchingProdSymbols(graph, spec.consumerTarget);
        if (consumerSyms.length === 0) {
          return {
            ...obl,
            status: "VIOLATED",
            evidence: [],
            finding: `未找到指定的目标消费计算 "${spec.consumerTarget}"`,
            remediation: `请核实目标计算函数名称，并将字段 "${spec.targetField}" 接入实际计算逻辑。`
          };
        }

        const normFld = normalizeFieldToken(spec.targetField);
        const consumedByTarget = consumerSyms.some((cs) => {
          if (domainReaders.some((r) => r.id === cs.id)) return true;
          if ((cs.reads || []).some((r) => normalizeFieldToken(r) === normFld)) return true;
          const activeParams = (cs.params || []).filter((p) => !(cs.unusedParams || []).includes(p));
          if (activeParams.some((p) => normalizeFieldToken(p) === normFld)) return true;
          // Check 1-hop caller passing `targetField` in `passedArgs` into an active parameter of `cs`
          for (const inEdge of graph.inEdgeDetails?.get(cs.id) || []) {
            const passed = inEdge.evidence?.passedArgs || [];
            if (activeParams.length > 0 && passed.some((arg) => normalizeFieldToken(arg).includes(normFld))) {
              return true;
            }
          }
          return false;
        });

        if (!consumedByTarget) {
          const primaryConsumer = consumerSyms[0];
          const legacyConsts = primaryConsumer.upperConstantsRead || [];
          const constHint =
            legacyConsts.length > 0
              ? `，仍然在使用常量 [${legacyConsts.slice(0, 4).join(", ")}]`
              : "";
          return {
            ...obl,
            status: "VIOLATED",
            evidence: [
              formatSymLoc(primaryConsumer),
              ...(persistenceOnlyReaders.length > 0
                ? [`仅在持久化侧读取: ${persistenceOnlyReaders.map(formatSymLoc).join(", ")}`]
                : [])
            ],
            finding: `违反：字段 "${spec.targetField}" 虽已定义/写入，但目标消费计算 "${primaryConsumer.name}" 未读取或接收该字段${constHint}`,
            remediation: `请在 ${formatSymLoc(primaryConsumer)} 中读取配置字段 "${spec.targetField}"（或通过实参传入并消费）以替换硬编码旧常量。`
          };
        }

        return {
          ...obl,
          status: "SATISFIED",
          evidence: consumerSyms.map(formatSymLoc),
          finding: `目标消费计算 "${spec.consumerTarget}" 已实际读取并消费字段 "${spec.targetField}"`,
          remediation: null
        };
      }

      if (domainReaders.length === 0) {
        if (isTelemetryOrAuditField(spec.targetField)) {
          return {
            ...obl,
            status: "INCONCLUSIVE",
            evidence: states.flatMap((st) => st.writers.map((id) => formatSymLoc(graph.symbolById.get(id)))),
            finding: `字段 "${spec.targetField}" 属于遥测/审计命名模式，仓内仅见写入未见业务计算读取，待确认外部采集消费`,
            remediation: null
          };
        }
        const writerEv = states.flatMap((st) => st.writers.map((id) => formatSymLoc(graph.symbolById.get(id)))).filter(Boolean);
        const persistNote =
          persistenceOnlyReaders.length > 0
            ? `（仅被持久化方法 [${persistenceOnlyReaders.map((p) => p.name).join(", ")}] 读取，无任何业务计算函数消费）`
            : "（全仓无任何读取消费者）";
        return {
          ...obl,
          status: "VIOLATED",
          evidence: [...writerEv, ...persistenceOnlyReaders.map(formatSymLoc)],
          finding: `违反：字段 "${spec.targetField}" 缺少实际业务计算消费者${persistNote}`,
          remediation: `请将 "${spec.targetField}" 接入下游核心过滤/业务逻辑计算${spec.inferredConsumers?.length ? `（参考同类消费者: ${spec.inferredConsumers.slice(0, 2).join(", ")}）` : ""}。`
        };
      }

      return {
        ...obl,
        status: "SATISFIED",
        evidence: domainReaders.map(formatSymLoc),
        finding: `字段 "${spec.targetField}" 已被下游业务函数 [${domainReaders.map((r) => r.name).join(", ")}] 实际读取消费`,
        remediation: null
      };
    }

    if (spec.targetSymbol) {
      const syms = findMatchingProdSymbols(graph, spec.targetSymbol);
      for (const s of syms) {
        if ((s.unusedParams || []).length > 0) {
          return {
            ...obl,
            status: "VIOLATED",
            evidence: [formatSymLoc(s)],
            finding: `目标符号 "${s.name}" 的形参 [${s.unusedParams.join(", ")}] 在函数体内未被消费`,
            remediation: `请在 ${formatSymLoc(s)} 内将入参接入实际处理逻辑。`
          };
        }
        if ((s.deadLocalVars || []).length > 0) {
          return {
            ...obl,
            status: "VIOLATED",
            evidence: [formatSymLoc(s)],
            finding: `目标符号 "${s.name}" 内部丢弃了局部变量 "${s.deadLocalVars[0].varName}" 的计算结果`,
            remediation: `请将 "${s.deadLocalVars[0].varName}" 传递至下游返回值或终端 Sink。`
          };
        }
      }
      if (syms.length > 0 && syms.some((s) => graph.reachesSink.has(s.id))) {
        return {
          ...obl,
          status: "SATISFIED",
          evidence: syms.map(formatSymLoc),
          finding: `目标符号 "${spec.targetSymbol}" 的入参与下游出水口链路闭合`,
          remediation: null
        };
      }
    }

    return {
      ...obl,
      status: "SATISFIED",
      evidence: [],
      finding: "L2 数据传递与消费检查未发现断流",
      remediation: null
    };
  }

  if (spec.type === "PAIRED_LIFECYCLE_SYMMETRY") {
    const asyms = graph.fieldLifecycleAsymmetries || [];
    const matchingAsym = spec.targetField
      ? asyms.find((a) => normalizeFieldToken(a.field) === normalizeFieldToken(spec.targetField))
      : (flowDiff?.newlyIntroducedLifecycleAsymmetries || asyms)[0];

    if (matchingAsym) {
      return {
        ...obl,
        status: "VIOLATED",
        evidence: [...(matchingAsym.saveMethods || []), ...(matchingAsym.loadMethods || [])],
        finding: matchingAsym.diagnosis,
        remediation:
          matchingAsym.kind === "SAVED_WITHOUT_LOAD_RECOVERY"
            ? `请在恢复方法 [${(matchingAsym.loadMethods || []).join(", ")}] 中读取存档并将字段 "${matchingAsym.field}" 写回实例状态。`
            : `请在保存方法 [${(matchingAsym.saveMethods || []).join(", ")}] 中序列化输出字段 "${matchingAsym.field}"。`
      };
    }

    if (spec.targetField && spec.requirePersistence === "required") {
      const states = findMatchingStateEntries(graph, spec.targetField);
      const readers = states.flatMap((st) => st.readers.map((id) => graph.symbolById.get(id))).filter(Boolean);
      const writers = states.flatMap((st) => st.writers.map((id) => graph.symbolById.get(id))).filter(Boolean);
      const hasSave = readers.some((s) => s.paired?.group.startsWith("Save/Load") && s.paired.side === "left");
      const hasLoad = writers.some((s) => s.paired?.group.startsWith("Save/Load") && s.paired.side === "right");
      if (!hasSave || !hasLoad) {
        return {
          ...obl,
          status: "VIOLATED",
          evidence: [...readers.map(formatSymLoc), ...writers.map(formatSymLoc)].slice(0, 4),
          finding: `违反：已明确要求持久化，但字段 "${spec.targetField}" 缺少${!hasSave && !hasLoad ? "保存与加载恢复" : !hasSave ? "保存侧读取" : "加载恢复侧写回"}实现`,
          remediation: `请为字段 "${spec.targetField}" 补齐 Save 序列化与 Load 反序列化恢复闭环。`
        };
      }
    }

    if (spec.targetField && spec.requirePersistence === "auto" && !spec.hasRefSaveLoad) {
      const states = findMatchingStateEntries(graph, spec.targetField);
      const allTouches = states
        .flatMap((st) => [...st.readers, ...st.writers].map((id) => graph.symbolById.get(id)))
        .filter(Boolean);
      const touchedPersistence = allTouches.some((s) => s.paired?.group.startsWith("Save/Load"));
      if (!touchedPersistence) {
        return {
          ...obl,
          status: "INCONCLUSIVE",
          evidence: allTouches.map(formatSymLoc).slice(0, 3),
          finding: `待确认：字段 "${spec.targetField}" 当前仅在运行期内存中读写，未接入持久化存档（若产品需求要求重启保留，请补接 Save/Load）`,
          remediation: "请对照产品需求确认该设置是否需要跨会话持久化。"
        };
      }
    }

    return {
      ...obl,
      status: "SATISFIED",
      evidence: [],
      finding: "成对生命周期与持久化恢复对称性核验通过",
      remediation: null
    };
  }

  if (spec.type === "BEHAVIORAL_TEST_EVIDENCE") {
    if (options.runTestsCommand) {
      try {
        execSync(options.runTestsCommand, {
          cwd: graph.workspaceRoot || process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60000
        });
        return {
          ...obl,
          status: "SATISFIED",
          evidence: [`command: ${options.runTestsCommand} (exit 0)`],
          finding: `L3 运行期测试命令 "${options.runTestsCommand}" 执行通过`,
          remediation: null
        };
      } catch (err) {
        return {
          ...obl,
          status: "VIOLATED",
          evidence: [`command: ${options.runTestsCommand} (failed)`],
          finding: `L3 运行期测试命令执行失败: ${(err.stderr || err.stdout || err.message || "").toString().slice(0, 240).trim()}`,
          remediation: "请修复导致测试失败的行为回归后重新验收。"
        };
      }
    }

    const testCallers = [];
    const targetNames = [spec.targetSymbol, spec.consumerTarget].filter(Boolean).map((n) => n.toLowerCase());
    const normFld = spec.targetField ? normalizeFieldToken(spec.targetField) : null;

    for (const sym of graph.symbolById.values()) {
      if (sym.zone !== "test") continue;
      const callsTarget = (sym.calls || []).some((c) => targetNames.includes(c.toLowerCase()));
      const touchesField =
        normFld &&
        ([...(sym.reads || []), ...(sym.writes || [])].some((f) => normalizeFieldToken(f) === normFld) ||
          normalizeFieldToken(sym.snippet || "").includes(normFld));
      if (callsTarget || touchesField) {
        testCallers.push(formatSymLoc(sym));
      }
    }

    if (testCallers.length > 0) {
      return {
        ...obl,
        status: "SATISFIED",
        evidence: testCallers.slice(0, 5),
        finding: `已发现覆盖目标符号/字段的测试代码 (${testCallers.length} 处)；运行测试通过后可闭环 L3 行为证据`,
        remediation: null
      };
    }

    return {
      ...obl,
      status: "INCONCLUSIVE",
      evidence: [],
      finding: "待确认：尚未检出针对本次接入目标的测试调用或运行探针证据（静态分析仅能证明 L1 结构与 L2 数据传递）",
      remediation: "建议补充端到端/单元测试验证改变输入后预期输出确实生效。"
    };
  }

  return {
    ...obl,
    status: "INCONCLUSIVE",
    evidence: [],
    finding: "未知校验项类型",
    remediation: null
  };
}

function inferAutomaticObligations(graph, flowDiff, scopedFiles, isFullScan, coveredTargets) {
  const autoResults = [];
  let autoSeq = 1;
  const nextAutoId = () => `AUTO-${autoSeq++}`;
  const profile = graph.workspaceProfile || { projectMode: "hybrid" };
  const inScope = (file) => (isFullScan ? true : scopedFiles.has(file));

  // A1. Missing Factory / Dispatcher Registration for Subclasses of a Shared Contract
  for (const [baseName, subs] of (graph.subclassesByBase || new Map()).entries()) {
    if (subs.length < 2) continue;
    const prodSubs = subs.filter((s) => s.zone === "prod");
    if (prodSubs.length < 2) continue;

    const registeredPeers = [];
    const unregisteredScopedSubs = [];
    for (const sub of prodSubs) {
      const extCallers = getExternalProdCallersOfContainer(graph, sub);
      if (extCallers.length > 0) {
        registeredPeers.push({ sub, extCallers });
      } else if (inScope(sub.file) && !coveredTargets.has(sub.name.toLowerCase())) {
        unregisteredScopedSubs.push(sub);
      }
    }

    if (registeredPeers.length > 0) {
      const registrarLocs = Array.from(
        new Set(registeredPeers.flatMap((p) => p.extCallers.map((ec) => formatSymLoc(ec.caller))))
      ).slice(0, 4);

      for (const unreg of unregisteredScopedSubs) {
        if (unreg.isFeatureGated || profile.hasDynamicPluginLoading) {
          autoResults.push({
            id: nextAutoId(),
            station: "REGISTRATION_OR_DISPATCH",
            layer: "L1_STRUCTURAL",
            required: false,
            targetLocation: formatSymLoc(unreg),
            reason: `同族契约 "${baseName}" 的其他实现已挂载到工厂/分发器，当前实现含条件编译或动态插件特征`,
            expectedRelation: `确认 ${unreg.name} 在目标平台或外部插件清单中已正确启用`,
            sourceBasis: `同族已注册实现: ${registeredPeers.map((p) => p.sub.name).join(", ")}`,
            status: "INCONCLUSIVE",
            evidence: [formatSymLoc(unreg), ...registrarLocs],
            finding: `待确认：同族实现 "${unreg.name}" 未见静态工厂引用（含按平台启用或动态插件加载特征）`,
            remediation: `若 "${unreg.name}" 非按平台裁剪或外部反射加载，请在 ${registrarLocs.join(" / ")} 中补齐注册。`
          });
        } else {
          autoResults.push({
            id: nextAutoId(),
            station: "REGISTRATION_OR_DISPATCH",
            layer: "L1_STRUCTURAL",
            required: true,
            targetLocation: formatSymLoc(unreg),
            reason: `继承/实现 "${baseName}" 的新增或变更子类必须同步加入工厂或分流注册表`,
            expectedRelation: `在 [${registrarLocs.join(", ")}] 中建立对 ${unreg.name} 的构造或注册引用`,
            sourceBasis: `同族实现挂载证据: ${registeredPeers.map((p) => p.sub.name).join(", ")}`,
            status: "VIOLATED",
            evidence: [formatSymLoc(unreg), ...registrarLocs],
            finding: `违反：实现类 "${unreg.name}" (契约 ${baseName}) 未加入工厂/分发器注册，导致运行期无法派发到该实现`,
            remediation: `请参照 [${registeredPeers.map((p) => p.sub.name).join(", ")}] 在 ${registrarLocs.join(" / ")} 中补齐 "${unreg.name}" 的注册分支。`
          });
        }
      }
    }

    // A2. Polymorphic / Multi-Platform Sibling Missing Method Implementation
    const baseContainers = (graph.containersByName?.get(baseName) || []).filter((c) => c.zone === "prod");
    const baseConcreteMethods = new Set();
    for (const bc of baseContainers) {
      if (bc.isInterface || bc.isTrait) continue;
      for (const m of graph.symbolById.values()) {
        if (m.parentContainerId === bc.id && m.kind === "method" && !m.isConstructor) {
          baseConcreteMethods.add(m.name);
        }
      }
    }

    const methodsBySub = new Map();
    for (const sub of prodSubs) {
      const mMap = new Map();
      for (const s of graph.symbolById.values()) {
        if (
          s.zone === "prod" &&
          s.kind === "method" &&
          !s.isConstructor &&
          s.isPublicApi &&
          !s.name.startsWith("_") &&
          (s.parentContainerId === sub.id || (s.file === sub.file && s.parentContainerName === sub.name))
        ) {
          mMap.set(s.name, s);
        }
      }
      methodsBySub.set(sub.id, mMap);
    }

    const candidateMethods = new Set();
    for (const sub of prodSubs) {
      if (!inScope(sub.file)) continue;
      for (const mName of (methodsBySub.get(sub.id) || new Map()).keys()) {
        if (!baseConcreteMethods.has(mName)) candidateMethods.add(mName);
      }
    }

    for (const mName of candidateMethods) {
      const implementers = prodSubs.filter((sub) => methodsBySub.get(sub.id)?.has(mName));
      const missingSubs = prodSubs.filter((sub) => !sub.isFeatureGated && !methodsBySub.get(sub.id)?.has(mName));
      if (implementers.length === 0 || missingSubs.length === 0) continue;

      // Require evidence that `mName` is either declared on the base contract OR invoked polymorphically by an external prod caller
      const declaredOnBase = baseContainers.some((bc) =>
        Array.from(graph.symbolById.values()).some((s) => s.file === bc.file && s.name === mName) ||
        (bc.snippet || "").includes(mName)
      );
      const polymorphicCallers = [];
      for (const imp of implementers) {
        const mSym = methodsBySub.get(imp.id).get(mName);
        for (const callerId of graph.callInEdges.get(mSym.id) || []) {
          const caller = graph.symbolById.get(callerId);
          if (!caller || caller.zone !== "prod" || caller.parentContainerId === imp.id) continue;
          const exclusivelyTargetsConcrete = (caller.qualifiedCalls || []).some(
            (qc) => qc.member === mName && qc.receiver === imp.name
          );
          if (!exclusivelyTargetsConcrete) polymorphicCallers.push(caller);
        }
      }

      if (declaredOnBase || polymorphicCallers.length > 0) {
        for (const miss of missingSubs) {
          autoResults.push({
            id: nextAutoId(),
            station: "REGISTRATION_OR_DISPATCH",
            layer: "L1_STRUCTURAL",
            required: true,
            targetLocation: formatSymLoc(miss),
            reason: `同族/跨平台实现共享契约 "${baseName}"，新增契约方法需在所有激活平台/分支实现中同步补齐`,
            expectedRelation: `在 ${miss.name} (${miss.file}) 中实现方法 ${mName}()`,
            sourceBasis: `已实现分支: ${implementers.map((i) => `${i.name}.${mName}`).join(", ")}`,
            status: "VIOLATED",
            evidence: [
              formatSymLoc(miss),
              ...implementers.map((i) => formatSymLoc(methodsBySub.get(i.id).get(mName))),
              ...polymorphicCallers.slice(0, 2).map(formatSymLoc)
            ],
            finding: `违反：同族/另一平台分支 "${miss.name}" 遗漏实现方法 "${mName}()"（上游已按共享契约 "${baseName}" 调用）`,
            remediation: `请在 ${miss.file} 的 ${miss.name} 中同步实现 "${mName}()"，保持多态/跨平台契约一致。`
          });
        }
      }
    }
  }

  // A3. Conditional-Compilation (`#[cfg]` / `#ifdef`) Same-Name Platform Twin Drift
  const gatedTwinsByKey = new Map();
  for (const s of graph.symbolById.values()) {
    if (s.zone !== "prod" || !s.isFeatureGated || (s.kind !== "function" && s.kind !== "method")) continue;
    const tKey = `${s.file}::${s.parentContainerName || ""}.${s.name}`;
    if (!gatedTwinsByKey.has(tKey)) gatedTwinsByKey.set(tKey, []);
    gatedTwinsByKey.get(tKey).push(s);
  }
  for (const twins of gatedTwinsByKey.values()) {
    if (twins.length < 2) continue;
    if (!twins.some((t) => inScope(t.file))) continue;
    const arities = new Set(twins.map((t) => (t.params || []).length));
    if (arities.size > 1) {
      autoResults.push({
        id: nextAutoId(),
        station: "REGISTRATION_OR_DISPATCH",
        layer: "L1_STRUCTURAL",
        required: true,
        targetLocation: twins.map(formatSymLoc).join(" | "),
        reason: "同一符号的多平台条件编译分支（#[cfg] / #ifdef）必须保持签名一致",
        expectedRelation: `对齐 ${twins[0].name} 在各平台分支中的参数签名`,
        sourceBasis: "条件编译对称契约",
        status: "VIOLATED",
        evidence: twins.map((t) => `${formatSymLoc(t)} -> params(${t.params.join(", ")})`),
        finding: `违反：条件编译同名函数 "${twins[0].name}" 在不同平台分支中参数数量不一致`,
        remediation: `请同步更新 ${twins[0].file} 中所有条件编译分支的 "${twins[0].name}" 签名与处理逻辑。`
      });
    }
  }

  // A4. Newly Added Unwired Functions / Unwired App Exports vs Legal Library Exports
  if (flowDiff) {
    for (const u of flowDiff.newlyAddedUnwired || []) {
      if (coveredTargets.has((u.name || "").toLowerCase())) continue;
      autoResults.push({
        id: nextAutoId(),
        station: "ENTRY_WIRING",
        layer: "L1_STRUCTURAL",
        required: u.verdict === "VIOLATED",
        targetLocation: u.symbol,
        reason:
          u.classification === "UNWIRED_NEW_EXPORT_IN_APP"
            ? "应用工程中的新增功能必须连通真实运行入口，不能把未被引用的 export 当作已接入"
            : "新增生产函数必须接入上游调用路径或外部契约入口",
        expectedRelation: `建立从真实入口或上游模块到 ${u.name} 的调用连接`,
        sourceBasis: "增量图差异分析 (G_base ➔ G_curr)",
        status: u.verdict,
        evidence: [u.symbol],
        finding: u.diagnosis,
        remediation:
          u.verdict === "VIOLATED"
            ? `请将 "${u.name}" 接入真实的 UI/IPC/路由/主流程入口；若确认属废弃实验草稿请直接删除。`
            : `请确认 "${u.name}" 是否由外部宿主动态调用；若是内部功能请补齐调用入口。`
      });
    }

    // Also record satisfied legal library API exports when in library mode and new public symbols were added!
    if (profile.projectMode === "library" && (flowDiff.addedSymbols || []).length > 0) {
      const addedPubExports = Array.from(graph.symbolById.values()).filter(
        (s) =>
          s.zone === "prod" &&
          (s.kind === "function" || s.kind === "method") &&
          s.isPublicApi &&
          (s.isPackageEntryExport || profile.projectMode === "library") &&
          inScope(s.file)
      );
      if (addedPubExports.length > 0 && autoResults.every((r) => r.station !== "ENTRY_WIRING")) {
        autoResults.push({
          id: nextAutoId(),
          station: "ENTRY_WIRING",
          layer: "L1_STRUCTURAL",
          required: true,
          targetLocation: addedPubExports.slice(0, 3).map(formatSymLoc).join(" | "),
          reason: "库工程新增公开 API 需通过包公开导出面暴露供外部调用方消费",
          expectedRelation: "公开导出并保持内部计算到返回值的完整数据流",
          sourceBasis: `项目类型识别: library (${profile.manifestKind || "package export"})`,
          status: "SATISFIED",
          evidence: addedPubExports.slice(0, 4).map(formatSymLoc),
          finding: `满足：库公开 API [${addedPubExports.slice(0, 3).map((s) => s.name).join(", ")}] 已作为合法外部入口导出`,
          remediation: null
        });
      }
    }

    // A5. Bridge Payload Drift & Newly Broken Bridges
    for (const b of flowDiff.newlyBrokenBridges || []) {
      autoResults.push({
        id: nextAutoId(),
        station: "PROTOCOL_COUNTERPART",
        layer: "L1_STRUCTURAL",
        required: true,
        targetLocation: `${b.fromFile}:${b.fromLine || 1} (${b.fromSymbol})`,
        reason: "跨语言/IPC/HTTP 调用必须存在明确匹配的对端处理器",
        expectedRelation: `${b.kind} 契约 "${b.contract}" 双端连通`,
        sourceBasis: "增量跨界桥接差异",
        status: b.status?.startsWith("AMBIGUOUS") ? "INCONCLUSIVE" : "VIOLATED",
        evidence: b.candidates || [`${b.fromFile} -> ${b.status}`],
        finding: b.status?.startsWith("AMBIGUOUS")
          ? `待确认：跨界桥 "${b.contract}" 匹配到多个同名候选实现 (${(b.candidates || []).join("; ")})`
          : `违反：跨界协议 "${b.contract}" 断链 (${b.status})`,
        remediation: b.status?.startsWith("AMBIGUOUS")
          ? "请核实具体服务命名空间或客户端前缀以消除多对端歧义。"
          : `请补齐或对齐 "${b.contract}" 的跨语言接收端实现。`
      });
    }

    for (const drift of flowDiff.bridgePayloadDiffs || []) {
      autoResults.push({
        id: nextAutoId(),
        station: "PROTOCOL_COUNTERPART",
        layer: "L2_DATA_FLOW",
        required: true,
        targetLocation: drift.to,
        reason: "前端/调用端更新协议字段后，后端/接收端必须同步解析并消费新字段",
        expectedRelation: `对端 ${drift.to} 接收并读取载荷字段 [${drift.unconsumedByBackend.join(", ")}]`,
        sourceBasis: `跨界桥 ${drift.kind}:${drift.contract}`,
        status: "VIOLATED",
        evidence: [drift.from, drift.to],
        finding: `违反：${drift.diagnosis}`,
        remediation: `请更新 ${drift.to} 的参数/请求体结构与处理逻辑以读取新字段 [${drift.unconsumedByBackend.join(", ")}]。`
      });
    }

    // A6. Newly Broken Paths, Orphaned Symbols & Writerless State Reads (including untouched files!)
    for (const orph of flowDiff.newlyOrphanedSymbols || []) {
      autoResults.push({
        id: nextAutoId(),
        station: "ENTRY_WIRING",
        layer: "L1_STRUCTURAL",
        required: true,
        targetLocation: orph.symbol,
        reason: "重构或修改调用方后，严禁将仍在使用的下游模块意外断流悬空（或遗留未清理的旧消费者）",
        expectedRelation: "恢复到该符号的有效调用边，或若已被新实现完整替代则彻底移除废弃旧实现",
        sourceBasis: "增量可达性图差异 (G_base ➔ G_curr)",
        status: "VIOLATED",
        evidence: [orph.symbol],
        finding: `违反：${orph.diagnosis}`,
        remediation: "请核实是否漏接了新入口到该节点的调用，或清理已被彻底替换的旧死代码。"
      });
    }

    for (const wls of flowDiff.newlyWriterlessStateReads || []) {
      autoResults.push({
        id: nextAutoId(),
        station: "DATA_FLOW_CONSUMPTION",
        layer: "L2_DATA_FLOW",
        required: true,
        targetLocation: wls.readers.join(" | "),
        reason: "重构状态写入字段时，所有关联消费者必须同步迁移到新状态字段",
        expectedRelation: `将消费者 [${wls.readers.join(", ")}] 迁移至新状态，或恢复对 "${wls.qualifiedField}" 的写入`,
        sourceBasis: `原写入方: ${wls.formerWriters.join(", ")}`,
        status: "VIOLATED",
        evidence: [...wls.readers, ...wls.formerWriters],
        finding: `违反：${wls.diagnosis}`,
        remediation: `请同步更新 [${wls.readers.join(", ")}] 使其读取重构后的新状态来源。`
      });
    }

    for (const wos of flowDiff.newlyWriteOnlyStates || []) {
      autoResults.push({
        id: nextAutoId(),
        station: "DATA_FLOW_CONSUMPTION",
        layer: "L2_DATA_FLOW",
        required: wos.verdict === "VIOLATED",
        targetLocation: wos.writers.join(" | "),
        reason: "写入的状态字段必须存在有效的下游消费者（单向外部遥测输出除外）",
        expectedRelation: `建立对状态 "${wos.qualifiedField}" 的下游消费读取`,
        sourceBasis: wos.formerReaders.length > 0 ? `原读取方: ${wos.formerReaders.join(", ")}` : "新增状态写读审计",
        status: wos.verdict,
        evidence: [...wos.writers, ...wos.formerReaders],
        finding: `${wos.verdict === "VIOLATED" ? "违反" : "待确认"}：${wos.diagnosis}`,
        remediation:
          wos.verdict === "VIOLATED"
            ? `请接通下游计算函数对 "${wos.qualifiedField}" 的读取，或清理已成为死路的状态写入。`
            : "请确认该遥测/审计字段是否已由序列化导出或外部探针消费。"
      });
    }
  }

  // A7. Config/Container Field Read ONLY by Persistence (`Save/Serialize`) While Sibling Fields Have Domain Consumers
  const domainConsumedScopes = new Map();
  for (const own of graph.stateOwnership.values()) {
    if (!own.scope) continue;
    const domReaders = own.readers
      .map((id) => graph.symbolById.get(id))
      .filter((s) => s && s.zone === "prod" && !isPersistenceOrSerializerSymbol(s));
    if (domReaders.length > 0) {
      if (!domainConsumedScopes.has(own.scope)) domainConsumedScopes.set(own.scope, []);
      domainConsumedScopes.get(own.scope).push({ field: own.field, readers: domReaders });
    }
  }

  for (const own of graph.stateOwnership.values()) {
    if (!own.scope || own.writers.length === 0 || own.readers.length === 0) continue;
    if (coveredTargets.has(own.field.toLowerCase()) || isTelemetryOrAuditField(own.field)) continue;
    const writerSyms = own.writers.map((id) => graph.symbolById.get(id)).filter(Boolean);
    if (!writerSyms.some((w) => inScope(w.file))) continue;

    const readerSyms = own.readers.map((id) => graph.symbolById.get(id)).filter((s) => s && s.zone === "prod");
    const domReaders = readerSyms.filter((s) => !isPersistenceOrSerializerSymbol(s));
    const persistReaders = readerSyms.filter((s) => isPersistenceOrSerializerSymbol(s));
    const siblingDomainExamples = domainConsumedScopes.get(own.scope) || [];

    if (domReaders.length === 0 && persistReaders.length > 0 && siblingDomainExamples.length > 0) {
      const sampleConsumer = siblingDomainExamples[0].readers[0];
      const constHint =
        (sampleConsumer?.upperConstantsRead || []).length > 0
          ? `（下游 ${sampleConsumer.name} 仍在读取常量 [${sampleConsumer.upperConstantsRead.slice(0, 3).join(", ")}]）`
          : "";
      autoResults.push({
        id: nextAutoId(),
        station: "DATA_FLOW_CONSUMPTION",
        layer: "L2_DATA_FLOW",
        required: true,
        targetLocation: sampleConsumer ? formatSymLoc(sampleConsumer) : writerSyms.map(formatSymLoc).join(" | "),
        reason: "新增或修改的配置字段不能只接入写入和保存，必须真正传入业务计算逻辑生效",
        expectedRelation: `下游业务计算（如 ${sampleConsumer ? sampleConsumer.name : "消费者"}）读取 "${own.qualifiedField}"`,
        sourceBasis: `同容器字段 "${siblingDomainExamples[0].field}" 由 ${formatSymLoc(sampleConsumer)} 消费`,
        status: "VIOLATED",
        evidence: [...writerSyms.map(formatSymLoc), ...persistReaders.map(formatSymLoc)],
        finding: `违反：字段 "${own.qualifiedField}" 仅在持久化方法 [${persistReaders.map((p) => p.name).join(", ")}] 中读取，无任何业务计算消费者${constHint}`,
        remediation: `请在下游计算逻辑（参考 ${formatSymLoc(sampleConsumer)}）中读取并使用 "${own.qualifiedField}"。`
      });
    }
  }

  // A8. Field-Level Save/Load Asymmetries (`SAVED_WITHOUT_LOAD_RECOVERY` / `LOADED_WITHOUT_SAVE_PERSISTENCE`)
  const asymList = flowDiff
    ? flowDiff.newlyIntroducedLifecycleAsymmetries || []
    : (graph.fieldLifecycleAsymmetries || []).filter((a) => (a.files || []).some((f) => inScope(f)));
  for (const asym of asymList) {
    if (coveredTargets.has(asym.field.toLowerCase())) continue;
    autoResults.push({
      id: nextAutoId(),
      station: "PAIRED_LIFECYCLE",
      layer: "L2_DATA_FLOW",
      required: true,
      targetLocation: (asym.loadMethods || []).join(" | ") || (asym.files || []).join(" | "),
      reason: "配置与状态持久化必须满足 Save ⇄ Load 字段级双向恢复闭环",
      expectedRelation: `字段 "${asym.qualifiedField}" 在保存与加载两侧对称读写`,
      sourceBasis: `保存侧 [${(asym.saveMethods || []).join(", ")}] vs 恢复侧 [${(asym.loadMethods || []).join(", ")}]`,
      status: "VIOLATED",
      evidence: [...(asym.saveMethods || []), ...(asym.loadMethods || [])],
      finding: `违反：${asym.diagnosis}`,
      remediation:
        asym.kind === "SAVED_WITHOUT_LOAD_RECOVERY"
          ? `请在恢复侧 [${(asym.loadMethods || []).join(", ")}] 中补齐对字段 "${asym.field}" 的写回恢复。`
          : `请在保存侧 [${(asym.saveMethods || []).join(", ")}] 中补齐对字段 "${asym.field}" 的读取保存。`
    });
  }

  // A9. One-Way Unmatched Event Emitters in Scoped Files -> Honest `INCONCLUSIVE` (never false PASS or false VIOLATED)
  const scopedUnmatchedEvents = (graph.unmatchedEventEmitters || []).filter((e) => inScope(e.fromFile));
  for (const evt of scopedUnmatchedEvents.slice(0, 5)) {
    autoResults.push({
      id: nextAutoId(),
      station: "PROTOCOL_COUNTERPART",
      layer: "L1_STRUCTURAL",
      required: false,
      targetLocation: `${evt.fromFile}:${evt.fromLine || 1} (${evt.fromSymbol})`,
      reason: "事件发射在仓内未检出静态监听者，可能由外部插件/宿主订阅，或遗漏了仓内订阅端",
      expectedRelation: `确认事件 "${evt.contract}" 的订阅消费者`,
      sourceBasis: "事件总线桥接扫描",
      status: "INCONCLUSIVE",
      evidence: [`${evt.fromFile}:${evt.fromLine || 1} emit("${evt.contract}")`],
      finding: `待确认：事件 "${evt.contract}" 在仓内未找到静态订阅者（若由外部插件动态加载或属单向通知则正常）`,
      remediation: `请确认事件 "${evt.contract}" 是否由外部插件订阅，若应在仓内消费请补接 listen/on 处理器。`
    });
  }

  return autoResults;
}

export function evaluateWiringContracts(currGraph, flowDiff, workspaceRoot, options = {}) {
  const activePlan = options.wiringPlan || (options.ignoreSavedPlan ? null : loadActiveWiringPlan(workspaceRoot));
  const isFullScan = Boolean(options.fullScan) && !flowDiff;
  const scopedFiles = new Set([
    ...(flowDiff?.changedSourceFiles || []),
    ...(options.changedFiles || [])
  ]);

  const evaluatedObligations = [];
  const coveredTargets = new Set();

  if (activePlan && Array.isArray(activePlan.obligations)) {
    if (activePlan.taskSpec?.targetSymbol) coveredTargets.add(activePlan.taskSpec.targetSymbol.toLowerCase());
    if (activePlan.taskSpec?.targetField) coveredTargets.add(activePlan.taskSpec.targetField.toLowerCase());
    for (const obl of activePlan.obligations) {
      evaluatedObligations.push(evaluateSinglePlanObligation(obl, currGraph, flowDiff, options));
    }
  }

  if (!isFullScan || !activePlan) {
    const autoObls = inferAutomaticObligations(currGraph, flowDiff, scopedFiles, isFullScan, coveredTargets);
    evaluatedObligations.push(...autoObls);
  }

  // If incremental diff touched prod files and found zero obligations so far, emit a concise verified L1/L2 summary obligation + L3 check
  if (evaluatedObligations.length === 0 && scopedFiles.size > 0) {
    evaluatedObligations.push({
      id: "AUTO-1",
      station: "ENTRY_WIRING",
      layer: "L1_STRUCTURAL",
      required: true,
      targetLocation: Array.from(scopedFiles).slice(0, 3).join(", "),
      reason: "变更文件的入口可达性、跨界桥接与局部数据流需保持连通",
      expectedRelation: "变更符号连通上游 Source 与下游 Sink，无新增断链",
      sourceBasis: "增量图差异审计",
      status: "SATISFIED",
      evidence: Array.from(scopedFiles).slice(0, 4),
      finding: "满足：本次变更文件的结构接通与状态读写未引入断链",
      remediation: null
    });
  }

  const counts = {
    total: evaluatedObligations.length,
    satisfied: evaluatedObligations.filter((o) => o.status === "SATISFIED").length,
    violated: evaluatedObligations.filter((o) => o.status === "VIOLATED").length,
    inconclusive: evaluatedObligations.filter((o) => o.status === "INCONCLUSIVE").length
  };

  const verificationVerdict =
    counts.violated > 0 ? "VIOLATED" : counts.inconclusive > 0 ? "INCONCLUSIVE" : "SATISFIED";

  const summaryLines = [];
  if (counts.total > 0) {
    summaryLines.push(
      `本次 ${counts.total} 项接入要求：${counts.satisfied} 项满足，${counts.violated} 项违反，${counts.inconclusive} 项待确认。`
    );
    for (const v of evaluatedObligations.filter((o) => o.status === "VIOLATED").slice(0, 4)) {
      summaryLines.push(`${v.finding}`);
    }
    for (const inc of evaluatedObligations.filter((o) => o.status === "INCONCLUSIVE").slice(0, 3)) {
      summaryLines.push(`${inc.finding}`);
    }
  } else {
    summaryLines.push("全仓静态水路审计未检出契约违反（当前无活动蓝图清单或增量差异）。");
  }

  return {
    verificationVerdict,
    headlineSummary: summaryLines.join(" "),
    wiringReport: {
      planId: activePlan?.planId || null,
      source: activePlan ? "SHARED_BLUEPRINT_AND_DIFF" : flowDiff ? "INCREMENTAL_GRAPH_DIFF" : "STATIC_WORKSPACE_SCAN",
      causalPipelineGoal: activePlan?.causalPipelineGoal || null,
      ambiguitiesToConfirm: activePlan?.ambiguitiesToConfirm || [],
      counts,
      obligations: evaluatedObligations
    }
  };
}
