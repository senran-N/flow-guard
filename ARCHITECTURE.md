# 架构查询指南

FlowGuard 的架构接口为 AI 提供可追溯的源码视野。它扫描代码并返回静态事实、候选关系与查询边界。扫描完成、存在引用或发现路径均不等于运行时行为已经正确。

## 从总览到源码

```powershell
node src/server.mjs --cli overview .
node src/server.mjs --cli overview . --level file --focus module:architecture --depth 0
node src/server.mjs --cli overview . --level symbol --focus src/server.mjs --depth 1
```

`architecture` 包含 `schemaVersion`、`graphId`、`query`、`scope`、`nodes`、`boundaryNodes`、`edges`、`coverage`、`mermaid`。模块和文件节点附带完整的 `drillDown` 工具参数；符号节点可跳到精确 ID 的 `flow_trace`。节点 ID 是当前源码查询标识，不是跨重构永久标识。

`level` 为 `module/file/symbol`。overview 默认 module；trace 默认 symbol。`focus` 接受节点 ID、工作区相对文件路径、模块目录或唯一符号名。同名符号要求使用 ID；文件和模块可匹配一组符号。`depth` 为 0–5；0 仅显示焦点范围，默认 1。`direction` 为 both/upstream/downstream。未指定 focus 的 overview 展示全仓，depth 对全仓总览不构成截断。

## 为具体任务找路径和影响面

```powershell
# 从 executeTool 到 buildWorkspaceFlowGraph，默认只沿高置信调用与已解析协议边
node src/server.mjs --cli trace . executeTool --to buildWorkspaceFlowGraph --max-hops 12

# 依赖影响包含注册关系，高置信和仅候选路径分开
node src/server.mjs --cli trace . generateFlowOverview --impact --max-hops 12

# 模块依赖环、孤立节点和枢纽
node src/server.mjs --cli overview . --level file --topology
```

路径结果位于 `paths`。`to` 是精确终点查询，与 target 使用相同的精确焦点解析规则；它不使用 trace 的模糊匹配结果擅自选定同名函数。返回最短简单路径及每条边的证据。`maxHops` 1–50（默认 12）、`maxPaths` 1–50（默认 5）、`searchBudget` 1–1000000（默认 20000）限制搜索。`search.complete` 及 depthLimited/pathLimited/budgetLimited 明示搜索是否截断。

`includeCandidates: true` / `--include-candidates` 才纳入候选边。`pathMode: relationships` / `--path-mode relationships` 可查看结构、注册和状态关系路径；此时不应将路径解释为执行顺序。默认 execution 排除这些关系及文件导入依赖。没有找到静态路径不证明运行时断开。

`impact: true` 需要 focus（trace 默认使用 target）。结果在 `architecture.impact`，按上下游、高置信/仅候选四组返回，逐项包含 hops 和 via，并报告深度和数量限制。`impactLimit` 默认 100，最大 1000。依赖影响包含调用、协议、注册和文件层导入，不包含状态/成员归属/继承。候选路径不是确定影响。

`includeTopology` / `--topology` 在分页及 focus 之前的完整投影上计算依赖 SCC、孤立源码节点和度数枢纽。粗粒度聚合可能形成符号调用图中不存在的模块依赖环；这些结果是审查线索，不是缺陷判决。

## 查询状态字段

```powershell
node src/server.mjs --cli trace /path/to/repo Settings.threshold --inspect-state
```

`stateImpact` 返回精确字段及作用域、生产写入方、读取方、读写单向证据、持久化命名线索和已有生命周期诊断。同名字段不会合并，使用 `AMBIGUOUS_STATE` 并列出候选。`maxStates` 默认 20（上限 200）、`maxOwners` 默认 30（上限 500）、`stateOffset` 支持有界输出，分别有匹配数、省略数和下一页。

`SAVE_NAME_HEURISTIC` / `LOAD_NAME_HEURISTIC` 只表示函数命名线索，不证明保存恢复成功。状态证据位置标为所属声明，不能冒充具体字段访问行。值是否最终改变业务输出仍需明确目标数据流及行为测试。

## 声明业务模块

在被扫描仓库根目录创建 `.flowguard-architecture.json`：

```json
{
  "schemaVersion": 1,
  "modules": [
    { "id": "transport", "name": "协议接入", "paths": ["src/server.mjs", "src/rpc-input.mjs"], "layer": "ENTRY_SURFACE" },
    { "id": "analysis", "name": "分析引擎", "paths": ["src/graph-builder.mjs", "src/file-parser.mjs"] }
  ]
}
```

paths 是相对文件或目录前缀，无通配符，以完整路径段匹配；最长前缀优先。重复路径、重复 ID、工作区外路径和无效字段会报错，配置 ID 不能与未映射的目录分组冲突。未映射文件沿用目录启发式。每个模块返回分组来源、配置依据、推断/声明层级、最近包清单。配置每次查询重新读取；包清单只说明源文件所属包，不证明业务隔离。

## 文件依赖与未知边界

module/file 视图包含 JS/TS/Vue/Svelte 的静态导入、字面量动态导入、require、重导出和副作用导入证据。IMPORT 仅代表文件依赖，不能满足函数调用要求。外部或未解析依赖单独列出，不按同名文件猜测。其他语言仍提供原有调用/状态/桥接分析，此处没有声称提供完整的多语言 import 图。

同一模块/文件内部的关系被折叠，`collapsedInternalRelations` 报告数量，向下展开可查看。符号层另提供状态节点、状态读写边。缺失对端的协议作为显式端点显示；状态和协议依旧保留静态不确定性。

## 完整遍历与证据

`maxNodes` 默认 40（上限 500），`maxEdges` 默认 80（上限 2000）。返回精确的匹配数、返回数、省略数、焦点外数量。节点按焦点距离、源码节点优先及稳定 ID 排序，以 `nextNodeOffset` / `nodeOffset` 继续。默认只返回当前节点页两端均存在的关系。

使用 `edgeScope: "all-matched"` / `--edge-scope all-matched` 可独立分页全部匹配关系，以 `nextEdgeOffset` / `edgeOffset` 继续；页外端点附在 boundaryNodes 中，保证边能查到两端。boundaryNodes 不占主节点页的 maxNodes 限额，其数量由 maxEdges 间接限制。图的 Mermaid 使用主节点加边界节点，与返回边完全一致。

翻页时传 `expectedGraphId` / `--expected-graph`，图发生变化则拒绝继续。图 ID 不包含节点/关系页偏移，包含当前层级投影、源文件哈希和模块配置。源码变更后重新从第一页查询。

关系预览最多 3 条证据、8 个解析候选和 3 个实参调用位置，明确标出总数和省略量。用返回的 edgeId 在同一 level 请求 `edgeId`、`evidenceOffset`、`maxEvidence`（默认 50，上限 500）可遍历该关系的全部证据。完整证据中的候选用 candidateOffset/maxCandidates 分页（默认 20，上限 200）；完整证据保留全部实参调用位置，返回量取决于被请求的源码事实。

## 比较架构变化

```powershell
node src/server.mjs --cli overview . --base HEAD~1
node src/server.mjs --cli overview . --level module --base HEAD~1 --diff-limit 100
```

`architectureDiff` 默认比较 file 层，显式 level 可选 module/symbol。通过 Git archive 在临时目录重建历史源码与当时配置；要求本机 Git 和 tar。无效 Git 引用、导出/解包失败直接报错，不当作“没有变化”。返回新增/删除节点与关系、受影响既有节点、总数及每类省略量（diffLimit 默认 100，上限 1000）。不运行项目脚本，不改写原仓库。比较只描述静态连接变化；符号移动可能改变其行号 ID，不代表新增/删除业务。

## 验证与边界

`npm run test:architecture` 包含独立 Floyd–Warshall 路径/SCC 对照、真实解析连接/断连、配置/作用域、分页/证据、MCP/CLI 传输用例。真实仓库复测脚本为 benchmark/architecture-validate.mjs 与 benchmark/architecture-source-audit.mjs；详细证据见十轮记录及版本化报告。

比较按节点 ID 和关系的端点、类型、置信度及状态判断增删；相同 ID 的节点名称、层级、统计或关系证据内容变化不单列为更新。需要审阅这些变化时，应对照两个版本的完整查询结果。

静态分析尚不能保证任意语言、宏生成源码、反射、运行期插件和动态协议的完整图。未解析候选及分析器限制必须作为结果的一部分保留，不能以测试通过宣称架构视野“绝对完美”。
