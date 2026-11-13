import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(process.argv[2]);
const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const frozen = process.argv.includes("--frozen");
const measuredEngine = frozen ? path.join(root, "engine-snapshot") : engineRoot;
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const manifests = [read(path.join(root, "manifest.json")), read(path.join(root, "holdout-scans/manifest.json"))];
const files = Object.fromEntries(fs.readdirSync(path.join(measuredEngine, "src")).filter((f) => f.endsWith(".mjs")).sort().map((f) => [f, hash(fs.readFileSync(path.join(measuredEngine, "src", f)))]));
assert.equal(hash(JSON.stringify(files)), manifests[0].engine.sourceHash, "Engine changed during evaluation");
assert.equal(manifests[0].engine.sourceHash, manifests[1].engine.sourceHash);
fs.mkdirSync(path.join(root, "engine-snapshot/src"), { recursive: true });
if (!frozen) {
  for (const file of Object.keys(files)) fs.copyFileSync(path.join(engineRoot, "src", file), path.join(root, "engine-snapshot/src", file));
  fs.copyFileSync(path.join(engineRoot, "package.json"), path.join(root, "engine-snapshot/package.json"));
}
const repositories = [], allRuns = [];
const integrity = [];
for (const manifest of manifests) {
  const stability = read(path.join(manifest.output, "stability.json"));
  const runs = read(path.join(manifest.output, "scan-runs.json"));
  allRuns.push(...runs);
  for (const stable of stability) {
    const repo = manifest.repositories.find((r) => r.name === stable.repository);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo.workspace, encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.workspace, encoding: "utf8" }).trim();
    assert.equal(status, repo.initialStatus, `${repo.name} working tree changed`);
    assert.equal(commit, repo.commit, `${repo.name} commit changed`);
    integrity.push({ repository: repo.name, commit, status, unchanged: true });
    const completed = runs.filter((r) => r.repository === repo.name && r.exitCode === 0 && r.resultHash);
    const data = completed.map((r) => read(r.destination));
    repositories.push({ name: repo.name, holdout: manifest !== manifests[0], commit, completed: !!stable.completed, deterministic: stable.deterministic,
      verifyMs: stable.verifyMs, files: data[0]?.graph.files, symbols: data[0]?.graph.symbols, rssMiB: data.length ? Math.max(...data.map((d) => d.rssMiB)) : null,
      violations: data[0]?.report.summary.obligationsViolated, projectMode: data[0]?.report.workspaceProfile.projectMode,
      oomObserved: runs.some((r) => r.repository === repo.name && /heap out of memory/.test(r.stderr)) });
  }
}
const mutationRoot = path.join(root, "mutations");
const mutations = read(path.join(mutationRoot, "results.json"));
// Metric v2: full-scan bridge errors block through blockingCount even when no
// corresponding wiring obligation exists. Recompute from preserved evidence.
for (const result of mutations.filter((r) => r.behavior.kind === "static-command-contract")) {
  for (const mode of ["full", "incremental"]) {
    const scan = result.scans[mode];
    if (scan.diagnostics.length > 0 && scan.overallVerdict === "VIOLATED") {
      scan.targetedViolation = true;
      scan.newTargetedViolation = !scan.baselineDetected;
    }
  }
}
const plans = read(path.join(root, "explicit-plans-complete/results.json"));
const reviews = read(path.join(root, "human-review.json"));
for (const copy of read(path.join(mutationRoot, "provenance.json"))) {
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: copy.copy, encoding: "utf8" }).trim(), "", `${copy.repository} copy was not restored`);
}
const defects = mutations.filter((r) => r.variant === "defect"), controls = mutations.filter((r) => r.variant === "control");
assert.equal(defects.length, 12); assert.equal(controls.length, 12);
assert.ok(defects.every((r) => !r.behavior.passed && !r.behavior.infrastructureFailure));
assert.ok(controls.every((r) => r.behavior.passed));
const planDefects = plans.filter((r) => r.variant === "defect"), planControls = plans.filter((r) => r.variant === "control");
assert.equal(planDefects.length, 10); assert.equal(planControls.length, 10);
const times = repositories.flatMap((r) => r.verifyMs).filter((v) => v != null).sort((a, b) => a - b);
const percentile = (p) => times[Math.ceil(times.length * p) - 1];
const stats = {
  metricVersion: 2, engineHash: manifests[0].engine.sourceHash, repositories: repositories.length, attemptedScans: allRuns.length,
  completedRepositories: repositories.filter((r) => r.completed).length,
  deterministicRepositories: repositories.filter((r) => r.deterministic).length,
  completedScans: allRuns.filter((r) => r.exitCode === 0 && r.resultHash).length,
  timeoutScans: allRuns.filter((r) => r.timedOut).length,
  p50VerifyMs: percentile(.5), p95VerifyMs: percentile(.95), maxObservedFinalRssMiB: Math.max(...repositories.map((r) => r.rssMiB || 0)),
  parsedFiles: repositories.reduce((n, r) => n + (r.files || 0), 0), symbols: repositories.reduce((n, r) => n + (r.symbols || 0), 0),
  violations: repositories.reduce((n, r) => n + (r.violations || 0), 0),
  default: Object.fromEntries(["full", "incremental"].map((mode) => [mode, {
    defects: defects.length, detected: defects.filter((r) => r.scans[mode].newlyDetected).length,
    targetedBlocked: defects.filter((r) => r.scans[mode].newTargetedViolation).length,
    legalControls: controls.length, targetedFalseAlarms: controls.filter((r) => r.scans[mode].newlyDetected).length,
    overallControlViolations: controls.filter((r) => r.scans[mode].overallVerdict === "VIOLATED").length
  }])),
  explicitPlans: { defects: planDefects.length, targetedBlocked: planDefects.filter((r) => r.targetedViolation).length,
    defectErrors: planDefects.filter((r) => r.engineError).length,
    legalControls: planControls.length, controlErrors: planControls.filter((r) => r.engineError).length,
    overallControlViolations: planControls.filter((r) => r.overallVerdict === "VIOLATED").length },
  review: { total: reviews.records.length, confirmedFalsePositives: reviews.records.filter((r) => r.label === "CONFIRMED_FALSE_POSITIVE").length, unresolved: reviews.records.filter((r) => r.label === "UNRESOLVED").length }
};
const summary = { generatedAt: new Date().toISOString(), environment: manifests[0].environment, stats, repositories, integrity };
fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(root, "summary.csv"), ["repository,commit,completed,deterministic,verify_ms_1,verify_ms_2,files,symbols,final_rss_mib,violations,project_mode,oom_observed", ...repositories.map((r) => [r.name, r.commit, r.completed, r.deterministic, ...r.verifyMs, r.files, r.symbols, r.rssMiB, r.violations, r.projectMode, r.oomObserved].join(","))].join("\n") + "\n");
const table = repositories.map((r) => `| ${r.name}${r.holdout ? "（新增样本）" : ""} | ${r.commit.slice(0, 12)} | ${r.completed ? r.verifyMs.map((ms) => (ms / 1000).toFixed(2)).join(" / ") : ">120 / >120"} | ${r.deterministic ? "一致" : r.oomObserved ? "超时；一次有 OOM 日志" : "超时"} | ${r.files ?? "—"} | ${r.violations ?? "—"} | ${r.projectMode ?? "—"} |`).join("\n");
const caseTable = defects.map((r) => {
  const p = planDefects.find((p) => p.id === r.id);
  return `| ${r.id} | ${r.holdout ? "新增仓库" : "原语料"} | ${r.behavior.kind === "static-command-contract" ? "命令契约核对" : "真实函数执行"} | ${r.scans.incremental.newlyDetected ? "是" : "否"} | ${r.scans.incremental.newTargetedViolation ? "是" : "否"} | ${!p ? "未测" : p.engineError ? "执行异常" : p.targetedViolation ? "是" : "否"} |`;
}).join("\n");
const reviewTable = reviews.records.map((r) => `| ${r.repository} | ${r.obligation.id} | ${r.label === "CONFIRMED_FALSE_POSITIVE" ? "误报" : "待确认"} | ${r.category} | ${r.rationale} |`).join("\n");
const report = `# FlowGuard 真实仓库验证报告（2026-11-11）

**当前版本适合人工审阅辅助，尚不适合直接用作生产 CI 的自动阻断门禁。** 这是对本次冻结代码的实测结论；单元测试通过不代表真实项目中的准确率已经达标。

## 范围与版本

- 用户目录中的 33 个仓库，加上新克隆的 p-limit、Click、chi，共 36 个仓库；每个仓库使用两个全新 Node 进程重复扫描，共 72 次。
- Node ${manifests[0].environment.node} / ${manifests[0].environment.platform} ${manifests[0].environment.arch}；默认自动项目模式，无活动蓝图；并发数 2，单个扫描任务上限 120 秒。两次新进程不等于清除了操作系统磁盘缓存。
- 引擎 HEAD：\`${manifests[0].engine.gitHead}\`；包含尚未提交的修复，因此以 src 文件 SHA-256 为准：\`${stats.engineHash}\`。结束时逐文件校验相同，副本保存在 \`engine-snapshot/\`。
- 每个仓库的完整提交、远程地址、初始状态在两份 manifest.json 中。36 个源仓库最终提交与工作区状态均未改变。故障注入只在归档创建的隔离副本中进行，副本已经恢复。
- 原有 33 个仓库曾用于此前调优；新增 3 个仓库单独标记。案例由本次源码检查后人工选取，不是随机抽样，也不构成独立盲测。

## 扫描稳定性与资源

| 指标 | 实测 |
|---|---|
| 时限内完成 | ${stats.completedRepositories}/36 个仓库；${stats.completedScans}/72 次扫描（91.7%） |
| 重复报告一致性 | ${stats.deterministicRepositories}/${stats.completedRepositories} 个已完成仓库，两轮 graph 摘要与完整报告哈希相同 |
| 未完成 | Bruno、llama.cpp、memos 均两次超时；memos 第一次同时出现 JavaScript heap out of memory 日志 |
| 已完成扫描 verify 耗时 | P50 ${(stats.p50VerifyMs / 1000).toFixed(2)} 秒；P95 ${(stats.p95VerifyMs / 1000).toFixed(2)} 秒 |
| 观测到的最大结束时 RSS | ${stats.maxObservedFinalRssMiB} MiB（不是实时峰值测量） |
| 已完成仓库解析规模 | ${stats.parsedFiles} 个文件，${stats.symbols} 个符号；含测试代码 |
| 原始阻断告警总数 | ${stats.violations} 条；不能当成真实缺陷数 |

120 秒限额覆盖验证和随后为统计而取得图信息的整个工作进程；不据此断言具体哪一步超时。耗时只统计成功完成的验证，超时样本没有被当作快速成功。语言支持按实际解析文件计，不能据此声称跨操作系统或所有语言均已验证。

## 有真值的故障注入与合法对照

在 8 个完整仓库副本中修改真实现有函数/协议，不插入人为的小型项目。12 个故障各有一个配对合法修改。所有原始行为探针先通过；10 个函数故障通过执行抽取的真实函数确认失败，对照通过。其余 2 个 Tauri 案例核对前端调用名、Rust 命令声明与注册表，没有启动桌面应用。这里未宣称执行了这 8 个项目的全部上游测试。

对“检出”的要求是出现与指定函数及形参、或指定桥接契约相符的新诊断；已有告警或同一仓库随便一条 VIOLATED 不算命中。

| 指标 | 全量默认模式 | 增量默认模式 |
|---|---|---|
| 有相关诊断的故障 | ${stats.default.full.detected}/12（91.7%） | ${stats.default.incremental.detected}/12（91.7%） |
| 有目标相关阻断的故障 | ${stats.default.full.targetedBlocked}/12（${(stats.default.full.targetedBlocked / 12 * 100).toFixed(1)}%） | ${stats.default.incremental.targetedBlocked}/12（${(stats.default.incremental.targetedBlocked / 12 * 100).toFixed(1)}%） |
| 合法对照出现新增相关诊断 | ${stats.default.full.targetedFalseAlarms}/12 | ${stats.default.incremental.targetedFalseAlarms}/12 |

增量模式中 10/12 个已确认故障最终仍为 SATISFIED（其中 9 个有参数断流诊断，1 个漏报）。全量模式的 ${stats.default.full.overallControlViolations}/12 个合法对照整体仍为 VIOLATED，原因是原有告警；该数不能当作“合法修改新增误报率”。12 个增量合法对照整体均为 SATISFIED。新增仓库的 3 个故障检出 2 个、默认目标阻断 0 个。

统计口径修正（metricVersion 2）：初版脚本仅检查 wiringReport.obligations 中的目标阻断，漏计了全量 brokenBridges 直接参与最终 blockingCount 的两条桥接故障。本报告从保留的原始 JSON 重算，全量目标阻断应为 2/12；没有重新运行或修改冻结引擎。原始 results.json 保留未覆盖；汇总使用修正口径。该问题也暴露了最终状态与义务清单/标题不一致的产品问题，但不是桥接故障被实际放行。

另外，使用修改前生成的显式 targetSymbol 蓝图复测 10 个函数案例：${stats.explicitPlans.targetedBlocked}/10 个故障得到目标 L2 阻断；Click 的一个故障漏报；Hono 的两个故障及其两个对照均执行异常。10 个合法对照中 ${stats.explicitPlans.overallControlViolations} 个整体 VIOLATED、${stats.explicitPlans.controlErrors} 个执行异常、4 个 INCONCLUSIVE。不能把执行异常计为成功检出，也不能把合法修改的无关入口告警算成缺陷检出。

| 案例 | 语料 | 真值依据 | 默认相关提示 | 默认目标阻断 | 显式蓝图目标 L2 阻断 |
|---|---|---|---|---|---|
${caseTable}

## 人工告警审阅

固定规则：对每个完成扫描且有 VIOLATED 的仓库取第一条，得到 29 条。Codex 逐条阅读声明、调用者及注册/导出代码，28 条标为误报，1 条待确认；没有据此确认新的上游真实缺陷。该规则偏向各仓库排在前面的规则类型，不是告警总体随机样本，**不能推算全局准确率、精确率或误报率**。尚无独立第二审阅者。

\`human-review.json\` 保存完整告警、源码摘录、行号、文件哈希、判断理由；判断仅针对选中的那一条。

| 仓库 | 告警 | 判断 | 类型 | 源码判断依据 |
|---|---|---|---|---|
${reviewTable}

## 优先修复的问题

1. **蓝图验证执行异常**：\`src/wiring-contract.mjs:892\` 对调用对象执行 c.toLowerCase()。Hono 的 control 与 defect 都能复现；完整堆栈见 \`explicit-plans-complete/hono-split-path/control.json\`。这条路径没有被当前合成回归样例覆盖。
2. **高置信度结论超出证据**：泛型约束/限定基类名解析错误、局部函数/trait/companion 作用域合并、继承或属性方法遗漏，均被升级为确定的 VIOLATED；应先修复类型与作用域，再收紧推断规则。
3. **项目入口识别不足**：chi、Click、httpx、Flask 等库被识别为应用；JSX、Nuxt 自动导入、Alembic、ORM/反射入口没有可靠识别。合法 API 和框架入口因此被阻断。
4. **诊断与门禁状态不一致**：默认模式发现参数未消费，却仍给 SATISFIED；需要明确区分“无任务契约的提示”和“已经证明通过”。桥接等问题可直接令最终状态 VIOLATED，却没有对应义务，标题可能仍称没有违反。不能直接把所有未使用参数升级为阻断，否则会增加误报。
5. **保留形参豁免过宽**：Click 的 _posixify(name) 被关联到 __getattr__(name) 的回调签名而豁免，真实输入丢失没有被检出；Rust 的 _ / _error / _monitors 又被从签名参数数量中丢弃。
6. **大仓资源边界**：三仓两轮未完成，memos 出现约 4 GB 堆上限错误；retrofit 的结束时 RSS 达数 GiB。需要阶段耗时、内存采样和复杂度分析，不能只增大超时来宣称通过。

## 其他验证与证据位置

- FlowGuard 自身 npm test：69 + 73 项断言及 38 项测试全部通过；当前全量自检通过。真实样本仍揭示上述问题。
- 新克隆 chi 的上游 \`go test ./... -count=1\` 通过（核心包与 middleware）。它支持该仓正常工作的判断，但不能证明每条静态告警都错误。
- \`scans/\`、\`holdout-scans/scans/\`：全量原始报告；\`scan-runs.json\`：退出状态、超时和 stderr；\`stability.json\`：重复结果。
- \`mutations/cases/\`：逐个案例的 patch、原始/对照/故障探针、探针输出和两种检测模式原始 JSON。
- \`explicit-plans-complete/\`：在原始代码生成并复用的显式蓝图、全部 20 次结果；\`explicit-plans/\` 保留第一次因 Hono 异常中断的补测证据，没有删除失败记录。
- \`manifest.json\`、\`summary.json\`、\`summary.csv\`、\`human-review.json\`：版本、汇总与标注；复现脚本位于 FlowGuard 的 \`benchmark/\`。

## 完整扫描清单

| 仓库 | 提交前缀 | 两轮 verify 秒数 | 结果 | 文件 | VIOLATED | 自动模式 |
|---|---|---|---|---|---|---|
${table}
`;
fs.writeFileSync(path.join(root, "REPORT.md"), report);
console.log(JSON.stringify(stats, null, 2));
