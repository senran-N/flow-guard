// Human review of exactly the first VIOLATED obligation in each completed, alerting repo.
// Labels apply to that finding only; this is not a random precision sample.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const labels = {
  Alamofire: ["错误泛化具体类型调用", "调用者明确将 request 转为 DataRequest / DataStreamRequest；没有以 Request 契约调用 DownloadRequest.didReceive。", [["Source/Core/SessionDelegate.swift", 260, 269], ["Source/Core/DownloadRequest.swift", 25, 28]]],
  axum: ["trait 作用域合并", "两个 call 分属 Handler<(), S> 和 Service<IncomingStream>，参数数目不同是两个接口的正常要求。", [["axum/src/routing/method_routing.rs", 1390, 1422]]],
  BepInEx: ["泛型约束误作继承", "类继承 AcceptableValueBase；where T : IEquatable<T> 是泛型约束，T 不是共享基类，更无 Add 契约。", [["BepInEx.Core/Configuration/AcceptableValueList.cs", 1, 16]]],
  "bits-ui": ["泛型约束误作继承", "TimeRangeFieldRootState 的 T extends TimeValue 是类型参数约束；类没有继承 TimeValue。", [["packages/bits-ui/src/lib/bits/time-range-field/time-range-field.svelte.ts", 64, 73]]],
  "clash-verge-rev": ["忽略保留形参导致参数计数错误", "两个平台版本都接收一个 &anyhow::Error；_error 仍是形参。", [["src-tauri/src/core/proxy_control.rs", 140, 153]]],
  Dapper: ["限定类型名截断", "实现的是 SqlMapper.ITypeMap，不是 SqlMapper；官方用例通过 SetTypeMap 显式注入。", [["Dapper/CustomPropertyTypeMap.cs", 5, 22], ["tests/Dapper.Tests/TypeHandlerTests.cs", 74, 87]]],
  dio: ["可选插件误要求内建注册", "NativeAdapter 是按需安装并赋给 dio.httpClientAdapter 的独立插件，README 和示例已有接入。", [["plugins/native_dio_adapter/README.md", 28, 44], ["plugins/native_dio_adapter/example/lib/main.dart", 68, 80]]],
  fastapi: ["声明式模型误要求工厂注册", "Discriminator 是 Pydantic 字段类型，已在 Schema.discriminator 声明；模型无需加入其它 BaseModel 子类的工厂。", [["fastapi/openapi/models.py", 95, 105], ["fastapi/openapi/models.py", 185, 197]]],
  fd: ["忽略保留形参导致参数计数错误", "Unix 和 Windows 两版本均有一个 fs::FileType 形参，Windows 使用 _ 并不改变签名。", [["src/filesystem.rs", 121, 129]]],
  flask: ["限定类型名截断及嵌套函数归属错误", "NoAppException 继承 click.UsageError，AppGroup 继承 click.Group；模块 click 不是共享基类，decorator 不是异常类契约。", [["src/flask/cli.py", 35, 38], ["src/flask/cli.py", 405, 431]]],
  fmt: ["中间基类契约需进一步确认", "BranchPattern 是模式树的中间类，Required/Optional 等子类实现 match；此次未穷尽动态构造路径，不将该告警计为已确认缺陷或误报。", [["support/docopt.py", 133, 147], ["support/docopt.py", 219, 240]], "UNRESOLVED"],
  "full-stack-fastapi-template": ["框架入口未识别", "upgrade 是 Alembic revision 的标准入口；项目 prestart 脚本通过 alembic upgrade head 调用迁移。", [["backend/app/alembic/versions/1a31ce608336_add_cascade_delete_relationships.py", 12, 26], ["backend/scripts/prestart.sh", 1, 8]]],
  gson: ["可选扩展误要求内建注册", "extras 的 InterceptorFactory 由用户 registerTypeAdapterFactory 注入，仓内测试有完整调用。", [["extras/src/main/java/com/google/gson/interceptors/InterceptorFactory.java", 27, 37], ["extras/src/test/java/com/google/gson/interceptors/InterceptorTest.java", 44, 55]]],
  hono: ["方法属性未识别", "PreparedRegExpRouter 已通过 match: typeof match<Router<T>, T> = match 实现 match，解析器漏掉了函数属性。", [["src/router/reg-exp-router/prepared-router.ts", 87, 104]]],
  httpx: ["嵌套函数误作类方法", "digest 是 DigestAuth._build_auth_header 内的局部函数，不是 Auth 要求 FunctionAuth 实现的方法。", [["httpx/_auth.py", 113, 123], ["httpx/_auth.py", 255, 270]]],
  koel: ["属性反射注册未识别", "RequiresDemo 被用于控制器属性，HandleDemoMode 通过 RequiresDemo::class 查找并处理。", [["app/Attributes/RequiresDemo.php", 1, 8], ["app/Http/Controllers/Demo/IndexController.php", 1, 18], ["app/Http/Middleware/HandleDemoMode.php", 26, 43]]],
  okhttp: ["companion 方法误作接口要求", "buildIfSupported 位于 Android10SocketAdapter.companion object；SocketAdapter 接口没有该方法。", [["okhttp/src/androidMain/kotlin/okhttp3/internal/platform/android/Android10SocketAdapter.kt", 78, 85], ["okhttp/src/androidMain/kotlin/okhttp3/internal/platform/android/SocketAdapter.kt", 24, 42]]],
  pinia: ["框架自动导入未识别", "Nuxt 模块已经用 addImports 注册 usePinia。", [["packages/nuxt/src/runtime/composables.ts", 1, 5], ["packages/nuxt/src/module.ts", 61, 74]]],
  pocketbase: ["库与应用模式识别错误", "项目明确支持作为 Go library 使用；NewApiError 是公开别名接口，无仓内调用者不构成接入违规。", [["apis/api_error_aliases.go", 1, 17], ["README.md", 49, 55]]],
  "pot-desktop": ["JSX 调用未识别", "WindowControl 已被 Config 和 Recognize 页面导入并作为 JSX 组件渲染。", [["src/components/WindowControl/index.jsx", 1, 12], ["src/window/Config/index.jsx", 62, 72], ["src/window/Recognize/index.jsx", 135, 143]]],
  retrofit: ["工厂返回实例未正确归属", "responseBodyConverter 已 return new OptionalConverter<>(delegate)，并非没有注册或创建路径。", [["retrofit/src/main/java/retrofit2/OptionalConverterFactory.java", 46, 69]]],
  ripgrep: ["嵌套函数作用域合并", "imp 分属 is_hidden_path、is_hidden_entry、strip_prefix 等不同外层函数；不能把所有局部 imp 当成同一跨平台函数。", [["crates/ignore/src/pathutil.rs", 19, 27], ["crates/ignore/src/pathutil.rs", 56, 64], ["crates/ignore/src/pathutil.rs", 93, 115]]],
  serilog: ["接口方法集合错误泛化", "ILogEventPropertyValueFactory 仅要求 CreatePropertyValue，DepthLimiter 已显式实现；CreateProperty 属于另一接口。", [["src/Serilog/Core/ILogEventPropertyValueFactory.cs", 7, 19], ["src/Serilog/Capturing/DepthLimiter.cs", 48, 58], ["src/Serilog/Capturing/MessageTemplateProcessor.cs", 17, 20]]],
  sidekiq: ["错误泛化具体实例调用", "JobSet.kill_all 明确创建 DeadSet 后调用 ds.trim；并未要求 ScheduledSet 实现 trim。", [["lib/sidekiq/api.rb", 756, 768], ["lib/sidekiq/api.rb", 910, 923]]],
  SwitchHosts: ["忽略保留形参导致参数计数错误", "macOS 和其它平台版本都接收三个参数，_monitors 被错误从参数个数中移除。", [["src-tauri/src/lifecycle.rs", 592, 598], ["src-tauri/src/lifecycle.rs", 629, 636]]],
  "uptime-kuma": ["ORM 动态加载未识别", "数据库启动时 autoloadModels 加载 server/model，APIKey 使用 R.dispense('api_key') 实例化。", [["server/database.js", 437, 447], ["server/model/api_key.js", 54, 69]]],
  zod: ["泛型参数误作继承及继承 getter 丢失", "ZodEffects 继承 ZodType，Input 是泛型参数；description 是基类提供的 getter。", [["packages/zod/src/v3/types.ts", 158, 167], ["packages/zod/src/v3/types.ts", 4318, 4325]]],
  chi: ["库与应用模式识别错误", "chi 是导入使用的 Go 路由库；Context.Clone 是公开 API，要求仓内运行入口是错误前提。", [["README.md", 6, 17], ["context.go", 101, 120], ["go.mod", 1, 5]]],
  click: ["限定类型名截断", "Sentinel 继承 enum.Enum；enum 是模块，不是工厂公共基类。枚举成员已经被模块导出使用。", [["src/click/_utils.py", 1, 19], ["src/click/_utils.py", 29, 38]]]
};

const root = path.resolve(process.argv[2]);
const manifests = [root, path.join(root, "holdout-scans")].map((dir) => JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
const selected = [];
for (const manifest of manifests) {
  const completed = JSON.parse(fs.readFileSync(path.join(manifest.output, "stability.json"), "utf8")).filter((s) => s.completed);
  for (const run of completed) {
    const raw = path.join(manifest.output, "scans", `${run.repository}.1.json`);
    const report = JSON.parse(fs.readFileSync(raw, "utf8")).report;
    const obligation = report.wiringReport.obligations.find((o) => o.status === "VIOLATED");
    if (!obligation) continue;
    const repo = manifest.repositories.find((r) => r.name === run.repository);
    const [category, rationale, spans, label = "CONFIRMED_FALSE_POSITIVE"] = labels[repo.name];
    const evidence = spans.map(([file, startLine, endLine]) => {
      const buffer = fs.readFileSync(path.join(repo.workspace, file));
      return { file, startLine, endLine, sourceSha256: crypto.createHash("sha256").update(buffer).digest("hex"), excerpt: buffer.toString("utf8").split(/\r?\n/).slice(startLine - 1, endLine).join("\n") };
    });
    selected.push({ repository: repo.name, commit: repo.commit, rawReport: raw, obligation, label, category, rationale, evidence });
  }
}
fs.writeFileSync(path.join(root, "human-review.json"), JSON.stringify({
  selection: "First VIOLATED obligation per completed repository with any violations; deterministic, non-random, not a population precision estimate.",
  reviewer: "Codex source inspection; no independent second reviewer", records: selected
}, null, 2));
console.log(JSON.stringify({ reviewed: selected.length, confirmedFalsePositives: selected.filter((r) => r.label === "CONFIRMED_FALSE_POSITIVE").length, unresolved: selected.filter((r) => r.label === "UNRESOLVED").length }));
