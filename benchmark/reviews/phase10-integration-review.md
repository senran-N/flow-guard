# Phase 10 integration review

Date: 2026-11-12

Scope reviewed (read-only): `src/rpc-input.mjs`, `src/react-lifecycle.mjs`, JS/TS config-import integration in `src/graph-builder.mjs` and `src/js-imports.mjs`, plus Cargo loading/project integration (`src/cargo-loader.mjs`, `src/rust-project.mjs`). This is not a full-repository audit.

## Rejected finding — invalid request without `id` is not a notification

Disposition: **REJECTED_BY_PRIMARY_SPEC**. The original reviewer reasoning is preserved below for audit.

The primary [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification#examples), section 7, explicitly shows a request with no `id` and a non-string `method` returning `-32600` with `id: null`. An invalid Request object is not a valid Notification. The suggested change was therefore rejected and the server remains unchanged.

`handleRpcMessage` validates the request before it checks whether `id` is absent. Consequently, a malformed notification (a request-shaped message with no `id`) emits an `Invalid Request` response. JSON-RPC notifications must never receive a response; malformed payload parsing remains distinguishable because it has no request object/id.

Reproduction:

```powershell
'{"jsonrpc":"2.0","method":7}' | node src/server.mjs
```

Observed output:

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}
```

Suggested minimal correction: after confirming the decoded value is an object (and preserving parse-error handling in the transport), determine notification status from the absence of the `id` member before sending validation errors. Invalid requests that contain a valid request id should continue receiving `-32600`. Add a real-process regression alongside the existing notification test.

## No high-priority finding reproduced in the reviewed scope

- RPC byte framing tests cover fragmented UTF-8, mixed framing, malformed JSON, framing bounds, and valid Content-Length responses.
- React lifecycle linking keeps mount/update callbacks as possible paths rather than confirmed execution, and its focused tests pass.
- JS/TS import configuration resolves only configured aliases/baseUrl, records config probes for cache invalidation, blocks configured misses from legacy alias guessing, and preserves package boundaries in focused tests.
- Cargo integration conservatively avoids selecting optional/target-conditional dependencies and has focused custom-bin/renamed-dependency coverage.

Focused checks executed before this review record:

```text
node --test test\verification-regression.test.mjs test\js-imports.test.mjs test\import-config-integration.test.mjs  # 31 passed
node test\task-benchmark-suite.mjs  # passed
```

No full test run or broad workspace scan was performed.
