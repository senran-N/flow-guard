import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildWorkspaceFlowGraph } from './graph-builder.mjs';
import { buildArchitectureProjection } from './architecture-model.mjs';

const run = (cwd, args, extra = {}) => execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 256 * 1024 * 1024, ...extra });
const nodeKey = node => node.id;
const edgeKey = edge => JSON.stringify([edge.from, edge.to, edge.kind, edge.confidence, edge.status]);
const stableNodes = model => new Map([...model.nodes.values()].map(n => [nodeKey(n), n]));
const stableEdges = model => new Map([...model.relations.values()].map(e => [edgeKey(e), e]));

export function compareArchitectureModels(before, after, options = {}) {
  const limit = options.diffLimit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid diffLimit');
  const oldNodes = stableNodes(before), newNodes = stableNodes(after), oldEdges = stableEdges(before), newEdges = stableEdges(after);
  const changed = (left, right) => [...right].filter(([key]) => !left.has(key)).map(([, value]) => value).sort((a, b) => a.id.localeCompare(b.id));
  const addedNodes = changed(oldNodes, newNodes), removedNodes = changed(newNodes, oldNodes);
  const addedEdges = changed(oldEdges, newEdges), removedEdges = changed(newEdges, oldEdges);
  const touched = new Set([...addedEdges, ...removedEdges].flatMap(e => [e.from, e.to]));
  const affected = [...touched].filter(id => oldNodes.has(id) && newNodes.has(id)).sort();
  const counts = { addedNodes: addedNodes.length, removedNodes: removedNodes.length, addedEdges: addedEdges.length, removedEdges: removedEdges.length, affectedExistingNodes: affected.length };
  return { level: before.level, counts, addedNodes: addedNodes.slice(0, limit), removedNodes: removedNodes.slice(0, limit),
    addedEdges: addedEdges.slice(0, limit), removedEdges: removedEdges.slice(0, limit), affectedExistingNodes: affected.slice(0, limit),
    omitted: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, Math.max(0, count - limit)])),
    limitations: ['A changed static dependency is not proof of a behavior regression.', 'Default file-level comparison avoids symbol line-number churn; symbol IDs may change when declarations move.'] };
}

export function compareWorkspaceArchitecture(workspaceRoot, currentGraph, options = {}) {
  if (typeof options.baseRef !== 'string' || !options.baseRef.trim() || options.baseRef.startsWith('-')) throw new TypeError('Architecture diff requires a valid baseRef');
  const commit = run(workspaceRoot, ['rev-parse', '--verify', `${options.baseRef}^{commit}`], { encoding: 'utf8' }).trim();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-architecture-base-'));
  try {
    // Git archive exports tracked source/configuration only and executes no project scripts.
    const prefix = run(workspaceRoot, ['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim().replace(/\/$/, '');
    const archive = run(workspaceRoot, ['archive', '--format=tar', prefix ? `${commit}:${prefix}` : commit]);
    execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024 });
    const beforeGraph = buildWorkspaceFlowGraph(temporary, true, { projectMode: options.projectMode || 'auto' });
    const level = options.level || 'file';
    const before = buildArchitectureProjection(beforeGraph, level), after = buildArchitectureProjection(currentGraph, level);
    const result = compareArchitectureModels(before, after, options);
    // Navigation in returned historical nodes must refer to the actual workspace, never a removed temp directory.
    const historicalNode = node => { const { drillDown, ...rest } = node; return rest; };
    result.addedNodes = result.addedNodes.map(historicalNode);
    result.removedNodes = result.removedNodes.map(historicalNode);
    return { baseline: { source: 'GIT_ARCHIVE', requestedRef: options.baseRef, commit }, ...result };
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('flowguard-architecture-base-')) throw new Error('Unsafe architecture baseline cleanup path');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
