# MCP 客户端集成验证

此目录是独立测试工程，依赖不进入 FlowGuard 运行包。需要 Node 20 或更高版本。

```sh
npm ci --prefix benchmark/mcp-client --ignore-scripts --no-audit --no-fund
npm run test:mcp-sdk
```

固定版本的官方 SDK 1.32.2 和 2.4.0 各自启动实际 `src/server.mjs` 子进程，通过 stdio 执行握手、四个工具、蓝图隔离、待确认结论、成功与失败的行为测试、错误调用及 ping。工作目录包含中文和空格，测试副本自动清理。输出记录客户端版本、Node 版本、平台和结果。此测试不代表所有 GUI MCP 宿主均已验收。

实现依据：[v1 官方客户端文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md)、[v2 官方客户端教程](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md)。
