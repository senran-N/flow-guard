import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as StdioV1 } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as ClientV2 } from '@modelcontextprotocol/client';
import { StdioClientTransport as StdioV2 } from '@modelcontextprotocol/client/stdio';

// Real SDK clients launch the packaged stdio entry point; no direct engine imports.
// Install the pinned dependencies with `npm ci --prefix benchmark/mcp-client`.
const server = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../../src/server.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard MCP 中文 '));
const results = [];
try {
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'src/worker.mjs'), 'export function calculate(value) {\n  return value + 1;\n}\n');
  fs.writeFileSync(path.join(root, 'src/main.mjs'), 'import { calculate } from "./worker.mjs";\nconsole.log(calculate(3));\n');
  for (const [sdk, Client, Transport] of [['1.32.2', ClientV1, StdioV1], ['2.4.0', ClientV2, StdioV2]]) {
    const transport = new Transport({ command: process.execPath, args: [server], cwd: root,
      env: { ...process.env, PLUGIN_DATA: path.join(root, '.state', sdk) }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (data) => { stderr += data.toString(); });
    const client = new Client({ name: 'flowguard-integration', version: '1.0.0' });
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: { workspaceRoot: root, ...args } });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content.find((block) => block.type === 'text').text);
    };
    try {
      await client.connect(transport);
      const list = await client.listTools();
      assert.deepEqual(list.tools.map((tool) => tool.name).sort(), ['flow_blueprint', 'flow_overview', 'flow_trace', 'flow_verify']);
      assert.equal(list.tools.find(tool => tool.name === 'flow_verify').inputSchema.properties.rustSemantic.type, 'boolean');
      const semantic = await call('flow_verify', { fullScan: true, rustSemantic: true, sessionId: 'schema', taskId: sdk });
      assert.equal(semantic.rustSemantics.outcome, 'NOT_APPLICABLE');
      const invalidSemantic = await client.callTool({ name: 'flow_verify', arguments: { workspaceRoot: root, rustSemantic: true } });
      assert.equal(invalidSemantic.isError, true);
      const overview = await call('flow_overview', { saveBaseline: true, sessionId: 'client', taskId: sdk });
      assert.ok(overview.zoneCounts.prodFiles >= 2);
      await call('flow_trace', { target: 'calculate' });
      const blueprint = await call('flow_blueprint', { reference: 'calculate', targetSymbol: 'calculate',
        requirePersistence: 'not_required', sessionId: 'client', taskId: sdk });
      const pending = await call('flow_verify', { fullScan: true, sessionId: 'client', taskId: sdk });
      assert.equal(pending.wiringReport.planId, blueprint.wiringPlan.planId);
      assert.equal(pending.verificationVerdict, 'INCONCLUSIVE');
      assert.equal(pending.status, 'INCONCLUSIVE');
      const passed = await call('flow_verify', { fullScan: true, sessionId: 'client', taskId: sdk,
        runTestsCommand: `"${process.execPath}" --input-type=module -e "import { calculate } from './src/worker.mjs'; if(calculate(3)!==4) process.exit(1)"` });
      assert.equal(passed.verificationVerdict, 'SATISFIED');
      fs.writeFileSync(path.join(root, 'src/worker.mjs'), 'export function calculate(value) {\n  return value + 2;\n}\n');
      const failed = await call('flow_verify', { fullScan: true, sessionId: 'client', taskId: sdk,
        runTestsCommand: `"${process.execPath}" --input-type=module -e "import { calculate } from './src/worker.mjs'; if(calculate(3)!==4) process.exit(1)"` });
      assert.equal(failed.verificationVerdict, 'VIOLATED');
      assert.equal(failed.status, 'ISSUES_FOUND');
      const missing = await client.callTool({ name: 'flow_unknown', arguments: {} });
      assert.equal(missing.isError, true);
      const invalid = await client.callTool({ name: 'flow_verify', arguments: { workspaceRoot: path.join(root, 'missing') } });
      assert.equal(invalid.isError, true);
      await client.ping();
      results.push({ sdk, outcome: 'PASSED', tests: ['initialize', 'list', 'overview', 'trace', 'blueprint',
        'inconclusive', 'behavior-pass', 'behavior-fail', 'unknown-tool', 'invalid-workspace', 'rust-semantic-schema', 'rust-semantic-inapplicable', 'rust-semantic-historical-guard', 'ping'], stderr });
    } catch (error) {
      results.push({ sdk, outcome: 'FAILED', error: error.stack, stderr });
      process.exitCode = 1;
    } finally {
      await client.close();
      fs.writeFileSync(path.join(root, 'src/worker.mjs'), 'export function calculate(value) {\n  return value + 1;\n}\n');
    }
  }
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('flowguard MCP '));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
