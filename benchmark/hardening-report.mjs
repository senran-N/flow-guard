import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2]);
const baseline = path.resolve(process.argv[3]);
const output = path.resolve(process.argv[4]);
const phase = process.argv[5] || "phase3";
const testCases = Number(process.argv[6] || 59);
assert.match(phase, /^phase\d+$/);
assert.ok(Number.isInteger(testCases) && testCases > 0);
assert.ok(!fs.existsSync(path.join(output, "summary.json")), "Existing evidence must not be overwritten");
const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const currentFiles = Object.fromEntries(fs.readdirSync(path.join(engineRoot, "src")).filter((f) => f.endsWith(".mjs")).sort().map((f) => [f, hash(fs.readFileSync(path.join(engineRoot, "src", f)))]));
const sourceHash = hash(JSON.stringify(currentFiles));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const repositories = [], manifests = [], allRuns = [], completedScans = [];
for (const [run, cohort] of [[`${phase}-corpus`, "original"], [`${phase}-holdouts`, "previous-holdout"], [`${phase}-new-holdouts`, "new-holdout"]]) {
  const directory = path.join(root, run), manifest = read(path.join(directory, "manifest.json"));
  assert.equal(manifest.engine.sourceHash, sourceHash, "Current code must match the frozen scans");
  manifests.push(manifest);
  const stability = read(path.join(directory, "stability.json"));
  const runs = read(path.join(directory, "scan-runs.json")); allRuns.push(...runs);
  for (const repo of manifest.repositories) {
    const stable = stability.find((s) => s.repository === repo.name);
    assert.equal(stable.finalStatus, repo.initialStatus);
    assert.equal(stable.finalCommit, repo.commit);
    assert.equal(git(repo.workspace, "status", "--porcelain"), repo.initialStatus);
    assert.equal(git(repo.workspace, "rev-parse", "HEAD"), repo.commit);
    const scans = runs.filter((r) => r.repository === repo.name && r.exitCode === 0 && r.resultHash).map((r) => read(r.destination));
    completedScans.push(...scans);
    const first = scans[0];
    repositories.push({ name: repo.name, cohort, commit: repo.commit, completed: stable.completed, deterministic: stable.deterministic,
      verifyMs: scans.map((s) => s.verifyMs), files: first?.graph.files, symbols: first?.graph.symbols,
      verdict: first?.report.verificationVerdict, violated: first?.report.summary.obligationsViolated,
      inconclusive: first?.report.summary.obligationsInconclusive, rssMiB: first?.rssMiB,
      firstViolations: first?.report.wiringReport.obligations.filter((o) => o.status === "VIOLATED").slice(0, 3).map((o) => ({ target: o.targetLocation, finding: o.finding })) });
  }
}
const mutationDir = path.join(baseline, `mutations-${phase}`);
const mutations = read(path.join(mutationDir, "results.json"));
const plans = read(path.join(baseline, `explicit-plans-${phase}`, "results.json"));
const newCases = read(path.join(root, `new-holdout-cases-${phase}`, "results.json"));
assert.equal(mutations.length, 24); assert.equal(plans.length, 20); assert.equal(newCases.length, 6);
for (const p of read(path.join(mutationDir, "provenance.json"))) {
  assert.equal(p.originalFinalStatus, ""); assert.equal(p.copyFinalStatus, "");
  assert.equal(git(p.original, "status", "--porcelain"), ""); assert.equal(git(p.copy, "status", "--porcelain"), "");
}
for (const p of read(path.join(root, `new-holdout-cases-${phase}`, "provenance.json"))) {
  assert.equal(p.originalStatus, ""); assert.equal(p.copyStatus, "");
  assert.equal(git(p.original, "status", "--porcelain"), ""); assert.equal(git(p.copy, "status", "--porcelain"), "");
}
const summarizeCases = (rows, mode, fresh = false) => {
  const defects = rows.filter((r) => r.variant === "defect"), controls = rows.filter((r) => r.variant === "control");
  return { defects: defects.length, controls: controls.length,
    diagnostics: defects.filter((r) => fresh ? r.scans[mode].diagnostic : r.scans[mode].newlyDetected).length,
    targetedBlocked: defects.filter((r) => fresh ? r.scans[mode].targetedBlock : r.scans[mode].newTargetedViolation).length,
    controlsBlocked: controls.filter((r) => (fresh ? r.scans[mode].verdict : r.scans[mode].overallVerdict) === "VIOLATED").length,
    controlsWithNewDiagnostics: controls.filter((r) => fresh ? r.scans[mode].diagnostic : r.scans[mode].newlyDetected).length,
    defectVerdicts: Object.fromEntries(["SATISFIED", "INCONCLUSIVE", "VIOLATED"].map((v) => [v, defects.filter((r) => (fresh ? r.scans[mode].verdict : r.scans[mode].overallVerdict) === v).length])),
    errors: rows.filter((r) => r.scans[mode].error || r.scans[mode].engineError).length };
};
const durations = completedScans.map((s) => s.verifyMs).sort((a, b) => a - b);
const quantile = (q) => durations[Math.ceil(durations.length * q) - 1];
const stats = {
  repositories: repositories.length, completed: repositories.filter((r) => r.completed).length,
  deterministic: repositories.filter((r) => r.deterministic).length,
  originalCompleted: repositories.filter((r) => r.cohort !== "new-holdout" && r.completed).length,
  scans: allRuns.length, completedScans: completedScans.length, timeouts: allRuns.filter((r) => r.timedOut).length,
  p50VerifyMs: quantile(.5), p95VerifyMs: quantile(.95), maxFinalRssMiB: Math.max(...completedScans.map((s) => s.rssMiB)),
  defaultFull: summarizeCases(mutations, "full"), defaultIncremental: summarizeCases(mutations, "incremental"),
  explicitPlans: { defects: 10, targetedBlocked: plans.filter((r) => r.variant === "defect" && r.targetedViolation).length,
    controls: 10, controlsBlocked: plans.filter((r) => r.variant === "control" && r.overallVerdict === "VIOLATED").length,
    errors: plans.filter((r) => r.engineError).length },
  newFull: summarizeCases(newCases, "full", true), newIncremental: summarizeCases(newCases, "incremental", true), newPlanned: summarizeCases(newCases, "planned", true)
};
const timerPath = path.join(root, `timer-behavior-${phase}`, "results.json");
const timerEvidence = fs.existsSync(timerPath) ? read(timerPath) : null;
if (timerEvidence) {
  assert.equal(timerEvidence.engineHash, sourceHash);
  assert.equal(timerEvidence.results.length, 2);
  stats.timerBehavior = timerEvidence.results.map((r) => ({ variant: r.variant, behaviorPassed: r.behavior.passed, targetStatus: r.target.status }));
}
fs.mkdirSync(output, { recursive: true });
const summary = { generatedAt: new Date().toISOString(), phase, sourceHash, engineFiles: currentFiles, environment: manifests[0].environment, stats, repositories,
  evidenceRoots: { root, baseline }, limitations: ["手选输入丢失与桥接案例，不是全局准确率估计", "默认扫描待确认项不能当作证明通过", "仍有框架入口/反射/类型作用域误报", "结束时 RSS 不是峰值内存", "部分扫描与测试并发，耗时仅供当前环境复现参考"] };
fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, "manifests.json"), JSON.stringify(manifests, null, 2));
fs.writeFileSync(path.join(output, "scan-runs.json"), JSON.stringify(allRuns, null, 2));
fs.writeFileSync(path.join(output, "new-cases.json"), JSON.stringify(newCases, null, 2));
fs.writeFileSync(path.join(output, "plans.json"), JSON.stringify(plans, null, 2));
fs.writeFileSync(path.join(output, "mutations.json"), JSON.stringify(mutations, null, 2));
if (timerEvidence) fs.writeFileSync(path.join(output, "timer-behavior.json"), JSON.stringify(timerEvidence, null, 2));
fs.writeFileSync(path.join(output, "repositories.csv"), ["repository,cohort,completed,deterministic,verify_ms_1,verify_ms_2,violated,inconclusive,commit", ...repositories.map((r) => [r.name,r.cohort,r.completed,r.deterministic,...[0,1].map((i) => r.verifyMs[i] ?? ""),r.violated ?? "",r.inconclusive ?? "",r.commit].join(","))].join("\n") + "\n");
const phase2 = read(path.join(root, "phase2-corpus", "manifest.json")).engine.sourceHash;
let phaseDetails = "";
const auditPath = path.join(root, `framework-source-audit-${phase}.json`);
if (fs.existsSync(auditPath)) {
  const audit = read(auditPath);
  assert.equal(audit.sourceHash, sourceHash);
  assert.ok(audit.checks.every((check) => check.passed));
  fs.copyFileSync(auditPath, path.join(output, "framework-source-audit.json"));
  const cacheEvidence = read(path.join(root, "cache-isolation-evidence.json"));
  assert.deepEqual(cacheEvidence.changedEngineFiles, ["graph-builder.mjs"]);
  assert.ok(cacheEvidence.unchangedReports.every((comparison) => comparison.sameHash));
  fs.copyFileSync(path.join(root, "cache-isolation-evidence.json"), path.join(output, "cache-isolation-evidence.json"));
  const comparison = ["dio", "sidekiq", "okhttp", "pot-desktop", "bruno", "full-stack-fastapi-template"].map((name) => {
    const before = read(path.join(root, "phase3-corpus", "scans", `${name}.1.json`));
    const after = repositories.find((repo) => repo.name === name);
    return `| ${name} | ${before.report.summary.obligationsViolated} | ${after.violated} |`;
  });
  const llama = repositories.find((repo) => repo.name === "llama.cpp");
  const llamaTiming = llama.completed
    ? `最终冻结版本 llama.cpp 的 verify 耗时为 ${llama.verifyMs.join(" / ")} ms`
    : `最终冻结版本 llama.cpp 未完成全部扫描，不能给出完整耗时或报告一致性结论`;
  phaseDetails = `
## 本轮缓存和框架修复

- 用源码及配置内容哈希、目录条目替代 2.5 秒图缓存 TTL。缓存单独复测中 Bruno、memos 的完整报告与 phase3 哈希相同；llama.cpp 两轮均完成。${llamaTiming}，整体进程完成情况见 scan-runs.json。仍沿用 120 秒上限。
- 补齐 Ruby gem、Dart pubspec、Gradle 库/应用边界；Gradle 代码生成任务的 mainClass 不再被当成应用声明。Dart 回调字段和跨行回调形参不再冒充 Function 方法。
- JSX 按实际导入绑定解析默认、具名及命名空间组件，保留渲染行号；支持 .jsx/.tsx 和含 JSX 的 .js/.mjs，以及模块顶层渲染。渲染关系不被伪装成已验证的 props 数据传递。
- Alembic 入口需同时匹配配置的版本目录与 revision/down_revision 元数据。${audit.checks.length} 项真实源码核查通过，路径、提交、文件哈希和证据片段见 [源码核查](./framework-source-audit.json)。

| 仓库 | phase3 阻断诊断数 | 本轮阻断诊断数 |
|---|---:|---:|
${comparison.join("\n")}

这是诊断数量对比，不是准确率。源码核查发现 phase4 虽已消除 Dio 的阻断告警，跨行回调形参仍会产生虚假的 Function 符号；phase5 修复后重新执行全语料、测试与变异，没有覆盖 phase4 证据。

phase5 的具体反例包括 pot-desktop 动态选择组件、Bruno 持久化计时器和 OkHttp 匿名回调。后续修复状态见本轮补充；不能据两轮一致或告警减少宣称生产门禁准确率。
`;
}
if (Number(phase.slice(5)) >= 7) {
  const old = read(path.join(engineRoot, "benchmark", "results", "2026-11-12-phase5", "summary.json"));
  const changed = ["okhttp", "pot-desktop", "bruno", "memos"].map((name) => {
    const prior = old.repositories.find((r) => r.name === name), now = repositories.find((r) => r.name === name);
    return `| ${name} | ${prior.violated} | ${now.violated} | ${now.inconclusive} |`;
  });
  phaseDetails += `
## 本轮回调、动态组件与计时器修复

Kotlin 匿名对象、具名 object 和 companion object 保留独立作用域。传入外部函数的匿名对象建立候选回调边；它不证明外部函数一定执行回调。JVM 基类按 package、明确导入和别名解析，避免把 java.util.logging.Handler 错连到本地 HTTP/2 Handler。真实漏实现的接口反例继续检出。

JSX 支持命名空间导入经过重新导出后的组件引用，以及 const 别名和运行时索引选择。确定组件的直接引用才给确定路径；动态选择进入候选路径和 INCONCLUSIVE 诊断，删除实际导出后不保留虚假连接。

保存方法内的 clearTimeout 等调用会消费对应句柄。仅凭方法命名和相邻字段有业务消费者，不足以证明该字段也必须参与业务计算，因此推断提示改为 INCONCLUSIVE；显式蓝图要求的字段/消费者断流仍为 VIOLATED。

| 仓库 | phase5 阻断诊断 | 本轮阻断诊断 | 本轮待确认 |
|---|---:|---:|---:|
${changed.join("\n")}

Bruno 新增一对真实源码计时器行为案例：以可控计时器和依赖替身执行原 CookiesStore。合法双括号实参保持一次延迟写入；取消调用丢失句柄时出现多个待执行写入，行为断言失败且目标 L2 阻断。phase6 曾误阻断合法括号写法，phase7 修复完整分组括号解析后复测通过。见 [计时器行为证据](./timer-behavior.json)。该案例参与了修复，不属于独立留出集，也不覆盖 Electron、加密或磁盘集成。

性能历史仍保留：phase6 的 llama.cpp 两轮再次超过 120 秒。最终阶段结果按本报告扫描表记录，不覆盖中间失败，也不将少量完成运行解释为广泛环境稳定性保证。全部报告的 RSS 仍是结束采样。
`;
}
if (phase === "phase8") {
  const priorFiles = read(path.join(root, "phase7-corpus", "manifest.json")).engine.files;
  const changedFiles = Object.keys(currentFiles).filter((file) => currentFiles[file] !== priorFiles[file]);
  assert.deepEqual(changedFiles, ["graph-builder.mjs", "lexer.mjs", "similarity-index.mjs"]);
  const comparisons = [];
  for (const cohort of ["corpus", "holdouts", "new-holdouts"]) {
    const prior = read(path.join(root, `phase7-${cohort}`, "scan-runs.json"));
    const current = read(path.join(root, `${phase}-${cohort}`, "scan-runs.json"));
    assert.equal(current.length, prior.length);
    for (const run of current) {
      const earlier = prior.find((item) => item.repository === run.repository && item.run === run.run);
      if (!run.resultHash || !earlier?.resultHash) {
        comparisons.push({ repository: run.repository, run: run.run, unchanged: null, timedOut: run.timedOut, exitCode: run.exitCode });
        continue;
      }
      assert.equal(run.resultHash, earlier.resultHash, `${run.repository} must preserve the complete report`);
      comparisons.push({ repository: run.repository, run: run.run, resultHash: run.resultHash, unchanged: true });
    }
  }
  const performance = read(path.join(root, `performance-${phase}`, "results.json"));
  assert.ok(performance.runs.length === 4, "All A/B attempts must be retained");
  const comparableRuns = performance.runs.filter((run) => run.exitCode === 0 && run.resultHash);
  assert.ok(comparableRuns.every((run) => run.resultHash === comparableRuns[0].resultHash));
  assert.equal(performance.engines[phase].sourceHash, sourceHash);
  const parser = read(path.join(root, "profiles", `parser-bounds-${phase}.json`));
  assert.ok(parser.every((item) => item.beforeHash === item.afterHash));
  fs.writeFileSync(path.join(output, "performance-equivalence.json"), JSON.stringify({ changedFiles, comparisons, parser, performance }, null, 2));
  phaseDetails += `
## 性能候选及等价性复测

声明边界查找从括号区间的二分定位处开始；相似代码比较只计算一次全局词片段顺序；图遍历使用队列下标，避免反复移动数组元素。没有减少文件、符号或比较对象。

这是候选版本的测量记录；报告等价本身不说明候选更快，是否保留须依据下面的耗时与内存结果。

源码只改变 ${changedFiles.join("、")}。${parser.length} 个大型文件的完整解析输出哈希相同；${comparisons.filter((item) => item.unchanged).length}/${comparisons.length} 次真实仓库扫描完成且完整图摘要与报告哈希和 phase7 相同。未完成扫描没有等价性结论。固定种子的相似度穷举对照继续通过。

另在同一台机器上按 phase7 / ${phase} / ${phase} / phase7 顺序，各启一个独立进程运行 llama.cpp，期间没有并发启动其他 FlowGuard 验证任务：

| 顺序 | 版本 | verify ms | 整体进程 ms | 结束 RSS MiB |
|---|---|---:|---:|---:|
${performance.runs.map((run, index) => `| ${index + 1} | ${run.phase}${run.timedOut ? "（超时）" : ""} | ${run.verifyMs ?? "—"} | ${run.elapsedMs} | ${run.rssMiB ?? "—"} |`).join("\n")}

${comparableRuns.length} 次完成运行的报告哈希一致，失败与超时单独记录。顺序交替可以减少先后顺序偏差，但无法控制操作系统后台负载；这仍是小样本单机测量，不能保证任意负载下都不超时。原始 CPU 剖析、六文件解析对比、每次运行记录均保留，见 [等价性与性能证据](./performance-equivalence.json)。
`;
}
if (Number(phase.slice(5)) >= 9) {
  const entries = read(path.join(root, `entry-source-cases-${phase}`, "results.json"));
  const provenance = read(path.join(root, `entry-source-cases-${phase}`, "provenance.json"));
  const native = read(path.join(root, `rust-module-probe-${phase}`, "results.json"));
  assert.equal(entries.sourceHash, sourceHash); assert.equal(native.sourceHash, sourceHash);
  assert.equal(entries.results.length, 4); assert.equal(native.results.length, 2);
  assert.equal(git(provenance.original, "status", "--porcelain"), "");
  assert.equal(git(provenance.copy, "status", "--porcelain"), "");
  assert.equal(git(provenance.original, "rev-parse", "HEAD"), provenance.commit);
  for (const row of entries.results) {
    assert.deepEqual(row.modes.planned.targetStatuses, [row.variant === "control" ? "SATISFIED" : "VIOLATED"]);
    if (row.variant === "defect") for (const mode of ["full", "incremental"]) assert.ok(row.modes[mode].targetStatuses.includes("VIOLATED"));
  }
  fs.writeFileSync(path.join(output, "entry-source-cases.json"), JSON.stringify({ entries, provenance }, null, 2));
  fs.writeFileSync(path.join(output, "rust-module-probe.json"), JSON.stringify(native, null, 2));
  phaseDetails += `
## Rust 导入连接与工具脚本引用修复

按真实 mod 声明建立模块树，解析 use 的分组、别名、通配符及 crate/self/super 路径，保留函数块作用域。支持常规模块文件、mod.rs、内联模块及显式 path 属性；未声明的同名文件和其他 crate 不再被当作导入证据。重导出循环保留未解析结果，避免路径增长导致递归溢出。

JS/TS 模块顶层调用保留调用行号，包括同时声明局部函数的脚本。只有测试或工具脚本引用的函数在默认扫描中标为 INCONCLUSIVE；这些调用不会成为生产运行入口，显式生产入口契约仍要求真实生产路径。

pot-desktop 原有 4 个入口误报和 zod 的 generate 入口误报均已核对真实源码。前者按 main 中的实际调用或注册连通；后者仍待确认用途，没有虚构生产入口。真实源码核查共 14 项。

从完整 pot-desktop 源码副本删除 start_server 调用或 tray_event_handler 注册：两对合法改动均不误阻断，两对故障在全量、增量和显式 L1 验收均检出。见 [真实断连案例](./entry-source-cases.json)。这两对是静态接线反例，不是执行 Tauri 程序的行为验证。

另以 ${native.compiler} 编译运行独立模块探针，正常别名/重导出调用行为通过，故意改接错误函数后断言失败且目标静态路径断开。见 [编译器行为探针](./rust-module-probe.json)。该探针为合成案例，不计入真实项目准确率。

中间版本的 ripgrep/Axum 出现导入递归溢出；修复后发现属性正则退化，已通过 CPU 剖析定位并改为直接扫描，Axum 单轮回到约 2.2 秒。中间失败保存在 phase9-preview 和 profiles/axum-rust-phase9 中。phase8 性能候选仍已撤回，本轮没有采用其三处优化。

尚不覆盖完整 Rust 类型推断、过程宏、全部 cfg 条件和 Cargo 自定义 target/跨依赖 crate 解析；无法据这些用例证明任意 Rust 工程的准确率。语法依据见 [Rust use declarations](https://doc.rust-lang.org/reference/items/use-declarations.html) 和 [Rust modules](https://doc.rust-lang.org/reference/items/modules.html)。
`;
}
const md = `# 2026-11-12 真实项目改进复测（${phase}）

原有 36 仓库中 ${stats.originalCompleted}/36 完成两轮扫描；加上本轮新克隆的 3 个仓库，共 ${stats.completed}/${stats.repositories} 完成，${stats.deterministic} 个完成仓库的两轮完整报告一致。原仓库及隔离副本未留下修改。**目前适合辅助审查及带明确目标的蓝图验收，仍不应直接作为任意项目的生产自动门禁。**

## 版本与方法

- 冻结源码 SHA-256：\`${sourceHash}\`。源码保存在每组扫描目录的 engine-snapshot，提交与逐文件哈希见 manifests.json。
- 对照基线：2026-11-11 报告，36 仓库、12 对变异；原始证据保留。本轮保持每个扫描进程 120 秒上限、每组两个工作进程，没有跳过困难目录。
- 中间阶段 phase2 使用 \`${phase2}\`：35/36 原有仓库完成，llama.cpp 两次超时；zod 同名版本基类混合误报在后续阶段修正。中间结果没有覆盖或删除。
- 扩充仓库：yocto-queue、packaging、httprouter。在 phase3 完成主要调优后克隆；后续轮次是同一组案例的回归验证，不是新的独立留出集。手选案例聚焦输入丢失，不能代表所有缺陷类型。

## 测量结果

| 指标 | 2026-11-11 基线 | 本轮 |
|---|---:|---:|
| 原有仓库两轮完成 | 33/36 | ${stats.originalCompleted}/36 |
| 原有 12 个故障的默认增量诊断 | 11/12 | ${stats.defaultIncremental.diagnostics}/12 |
| 原有 12 个故障的默认增量目标阻断 | 2/12 | ${stats.defaultIncremental.targetedBlocked}/12 |
| 10 个明确函数目标的 L2 阻断 | 7/10，另有 2 个执行异常 | ${stats.explicitPlans.targetedBlocked}/10，${stats.explicitPlans.errors} 个异常 |
| 10 个蓝图合法改动被阻断 | 4/10，另有 2 个执行异常 | ${stats.explicitPlans.controlsBlocked}/10 |
| 新 3 个故障的默认增量诊断 | — | ${stats.newIncremental.diagnostics}/3 |
| 新 3 个故障的蓝图目标阻断 | — | ${stats.newPlanned.targetedBlocked}/3 |
| 新 3 个蓝图合法改动被阻断 | — | ${stats.newPlanned.controlsBlocked}/3 |

全量模式的原有目标诊断为 ${stats.defaultFull.diagnostics}/12、目标阻断 ${stats.defaultFull.targetedBlocked}/12；${stats.defaultFull.controlsBlocked}/12 个合法改动的全量结果仍因既有发现被阻断。增量合法对照新增相关诊断 ${stats.defaultIncremental.controlsWithNewDiagnostics}/12，整体阻断 ${stats.defaultIncremental.controlsBlocked}/12。

默认增量故障结论分布：${JSON.stringify(stats.defaultIncremental.defectVerdicts)}。未使用的形参可能是保留接口，因此默认提示 INCONCLUSIVE；在显式目标契约要求消费输入时才确定阻断。诊断检出率与阻断率必须分别报告。蓝图合法对照的行为层保持待确认；独立行为探针验证了变异真值，但没有被伪装成蓝图已执行的 L3 测试。

共 ${stats.scans} 次扫描，完成 ${stats.completedScans} 次，超时 ${stats.timeouts} 次。已完成扫描的验证耗时 P50 ${stats.p50VerifyMs} ms、P95 ${stats.p95VerifyMs} ms，最大结束时 RSS ${stats.maxFinalRssMiB} MiB。RSS 不是进程峰值；扫描期间存在其他测试任务，不能把这些耗时解释为受控性能基准。

## 改动与验证

包边界区分 JS/TS monorepo 子包、Go 库和命令、Python 库和显式应用；Go 同包函数调用采用实际 package 声明。条件编译只比较互斥分支的重载集合。补齐单行函数和多行泛型类的解析，并分离版本不同的同名基类。

断桥、数据流阻断和待确认项统一进入义务计数与标题。状态格式升级，旧基线需重新生成。相似代码检测使用精确 Jaccard 前缀索引，与穷举比较做固定种子校验；同文件引用扫描建立索引，优化前后抽查 6 个真实文件的完整解析输出哈希一致，没有缩小解析范围。

Node 24.14.0 的 142 项断言 + ${testCases} 个测试通过；Node 18.20.8 兼容性验证及项目自检日志见本地证据目录。httprouter 的 phase3 原生 go test ./... 通过。其余仓库并未全部安装依赖、运行完整上游测试。

${phaseDetails}

## 仍需解决

框架回调、反射注册、动态导出、未识别的包配置和限定类型作用域仍有误报；全量告警数量不能当作已确认 bug 数量。原始误报抽样标签不能直接套用新版本，也不能据告警减少计算全局精确率。还需扩充独立故障类型、逐条审阅残余误报，并验证运行期行为和更广的平台环境。

本地完整证据：\`${root.replace(/\\/g,"/")}\`；原 12 对变异和蓝图复测在 \`${baseline.replace(/\\/g,"/")}\` 的 mutations-${phase}、explicit-plans-${phase}。仓库概览见 repositories.csv；逐条扩充案例和蓝图结果见 new-cases.json、plans.json。
`;
fs.writeFileSync(path.join(output, "REPORT.md"), md);
console.log(JSON.stringify({ output, sourceHash, stats }, null, 2));
