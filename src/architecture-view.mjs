import { resolveArchitectureFocus } from './architecture-focus.mjs';
import { buildArchitectureProjection } from './architecture-model.mjs';
import crypto from 'node:crypto';
import { summarizeArchitectureTopology, inspectArchitectureImpact } from './architecture-topology.mjs';
import { architectureEvidence } from './architecture-evidence.mjs';

const LEVELS = ['module', 'file', 'symbol'];
const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export function architectureOptions(options = {}) {
  const result = {
    level: options.level ?? 'module', depth: options.depth ?? 1,
    direction: options.direction ?? 'both', maxNodes: options.maxNodes ?? 40,
    maxEdges: options.maxEdges ?? 80, nodeOffset: options.nodeOffset ?? 0, edgeOffset: options.edgeOffset ?? 0,
    edgeScope: options.edgeScope ?? 'node-page', evidenceOffset: options.evidenceOffset ?? 0, maxEvidence: options.maxEvidence ?? 50,
    candidateOffset: options.candidateOffset ?? 0, maxCandidates: options.maxCandidates ?? 20
  };
  if (!LEVELS.includes(result.level)) throw new TypeError('Invalid level: expected module, file or symbol');
  for (const key of ['impact', 'includeTopology']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(`Invalid ${key}`);
  if (!['node-page', 'all-matched'].includes(result.edgeScope)) throw new TypeError('Invalid edgeScope');
  if (!['both', 'upstream', 'downstream'].includes(result.direction)) throw new TypeError('Invalid direction');
  for (const [key, min, max] of [['depth', 0, 5], ['maxNodes', 1, 500], ['maxEdges', 1, 2000], ['nodeOffset', 0, Number.MAX_SAFE_INTEGER], ['edgeOffset', 0, Number.MAX_SAFE_INTEGER], ['evidenceOffset', 0, Number.MAX_SAFE_INTEGER], ['maxEvidence', 1, 500], ['candidateOffset', 0, Number.MAX_SAFE_INTEGER], ['maxCandidates', 1, 200]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new TypeError(`Invalid ${key}`);
  }
  if (options.focus !== undefined && (typeof options.focus !== 'string' || !options.focus.trim())) throw new TypeError('focus must be a nonempty node ID, module, file or unique symbol name');
  for (const key of ['edgeId', 'expectedGraphId']) if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) throw new TypeError(`Invalid ${key}`);
  return result;
}

export function buildArchitectureView(graph, options = {}) {
  if (options.impact && !options.focus) throw new TypeError('Architecture impact requires a focus');
  const query = architectureOptions(options);
  const { level, depth, direction, maxNodes, maxEdges, nodeOffset, edgeOffset } = query;
  const model = buildArchitectureProjection(graph, level, { ...options, ...query });
  const { nodes, relations, project, collapsedInternalRelations } = model;
  const graphId = crypto.createHash('sha256').update(JSON.stringify({
    files: graph.files.map(f => [f.file, f.zone, f.contentHash]).sort(),
    config: model.grouping.configuration,
    nodes: [...nodes.values()].sort(compare), edges: [...relations.values()].sort(compare)
  })).digest('hex');
  if (options.expectedGraphId !== undefined && options.expectedGraphId !== graphId) throw new Error('Architecture graph changed; restart pagination with the current graphId');
  let seeds = [];
  if (options.focusIds) seeds = [...new Set(options.focusIds.map(id => graph.symbolById.get(id)).filter(s => s?.zone === 'prod').map(project))];
  else if (options.focus !== undefined) seeds = resolveArchitectureFocus(model, options.focus);
  const focused = options.focus !== undefined || options.focusIds !== undefined;
  const distance = new Map(seeds.map(id => [id, 0]));
  if (focused) {
    const adjacency = new Map();
    const connect = (from, to) => { if (!adjacency.has(from)) adjacency.set(from, new Set()); adjacency.get(from).add(to); };
    for (const edge of relations.values()) {
      if (direction !== 'upstream') connect(edge.from, edge.to);
      if (direction !== 'downstream') connect(edge.to, edge.from);
    }
    const queue = [...seeds];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i], d = distance.get(id);
      if (d >= depth) continue;
      for (const next of adjacency.get(id) || []) if (!distance.has(next)) { distance.set(next, d + 1); queue.push(next); }
    }
  }
  const eligible = [...nodes.values()].filter(n => !focused || distance.has(n.id))
    .sort((a, b) => (distance.get(a.id) || 0) - (distance.get(b.id) || 0) ||
      Number(!['MODULE', 'FILE', 'SYMBOL'].includes(a.kind)) - Number(!['MODULE', 'FILE', 'SYMBOL'].includes(b.kind)) || compare(a, b));
  const selected = eligible.slice(nodeOffset, nodeOffset + maxNodes);
  const selectedIds = new Set(selected.map(n => n.id));
  const eligibleIds = new Set(eligible.map(n => n.id));
  const allEdges = [...relations.values()];
  const eligibleEdges = allEdges.filter(e => eligibleIds.has(e.from) && eligibleIds.has(e.to));
  const nodePageEdges = eligibleEdges.filter(e => selectedIds.has(e.from) && selectedIds.has(e.to));
  const pageEdges = (query.edgeScope === 'all-matched' ? eligibleEdges : nodePageEdges).sort(compare);
  const edges = pageEdges.slice(edgeOffset, edgeOffset + maxEdges).map(e => ({ ...e, omittedEvidenceCount: e.evidenceCount - e.evidence.length }));
  const boundaryIds = new Set(edges.flatMap(e => [e.from, e.to]).filter(id => !selectedIds.has(id)));
  const boundaryNodes = [...boundaryIds].sort().map(id => nodes.get(id));
  let relationEvidence;
  if (options.edgeId !== undefined) {
    const relation = [...relations.values()].find(e => e.id === options.edgeId);
    if (!relation) throw new Error('Architecture edgeId not found in this level');
    relationEvidence = { edgeId: relation.id, total: relation.evidenceCount,
      evidence: model.requestedEvidence.map(e => architectureEvidence(e, { ...query, maxArgumentSites: Number.MAX_SAFE_INTEGER })),
      nextEvidenceOffset: query.evidenceOffset + model.requestedEvidence.length < relation.evidenceCount ? query.evidenceOffset + model.requestedEvidence.length : null };
  }
  const nextOffset = nodeOffset + selected.length < eligible.length ? nodeOffset + selected.length : null;
  const navigation = {
    ...(graph.workspaceRoot ? { workspaceRoot: graph.workspaceRoot } : {}),
    ...(options.projectMode ? { projectMode: options.projectMode } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {})
  };
  const navigableNode = node => node.drillDown ? { ...node, drillDown: { ...node.drillDown,
    arguments: { ...navigation, ...node.drillDown.arguments } } } : node;
  return {
    schemaVersion: 1, graphId, query: { ...query, focus: options.focus ?? null },
    ...(options.includeTopology ? { topology: summarizeArchitectureTopology(model) } : {}),
    ...(options.impact && options.focus ? { impact: inspectArchitectureImpact(model, options.focus, options) } : {}),
    scope: { zone: 'prod', analysis: 'STATIC', grouping: model.grouping.configuration.modules.length ? 'EXPLICIT_CONFIG_WITH_DIRECTORY_FALLBACK' : 'DIRECTORY_HEURISTIC',
      analysisLimitations: (graph.analysisLimitations || []).slice(0, 20),
      analysisLimitationsCount: (graph.analysisLimitations || []).length,
      omittedAnalysisLimitations: Math.max(0, (graph.analysisLimitations || []).length - 20),
      dependencyCoverage: { languages: ['ts', 'vue'], unresolvedImports: model.dependencies.records.filter(r => r.status !== 'RESOLVED').length,
        limitations: model.dependencies.limitations },
      limitations: ['Module boundaries use explicit project configuration where present, otherwise directory heuristics; neither proves runtime isolation.',
        'Candidate edges, registration, state and structural relations do not prove runtime execution.',
        'Relations missing from this static graph may still exist at runtime.'] },
    nodes: selected.map(navigableNode), boundaryNodes: boundaryNodes.map(navigableNode), edges,
    ...(relationEvidence ? { relationEvidence } : {}),
    coverage: { totalNodes: nodes.size, totalEdges: relations.size, collapsedInternalRelations,
      matchedNodes: eligible.length, matchedEdges: eligibleEdges.length,
      returnedNodes: selected.length, returnedEdges: edges.length,
      omittedNodes: eligible.length - selected.length, omittedEdges: eligibleEdges.length - edges.length,
      returnedBoundaryNodes: boundaryNodes.length, edgesOutsideNodePage: eligibleEdges.length - nodePageEdges.length,
      excludedByFocusNodes: nodes.size - eligible.length, excludedByFocusEdges: relations.size - eligibleEdges.length,
      truncated: eligible.length > selected.length || eligibleEdges.length > edges.length, nextNodeOffset: nextOffset,
      nextEdgeOffset: edgeOffset + edges.length < pageEdges.length ? edgeOffset + edges.length : null },
    mermaid: renderArchitectureMermaid([...selected, ...boundaryNodes], edges)
  };
}

export function renderArchitectureMermaid(nodes, edges) {
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const label = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]/g, ' ');
  return ['```mermaid', 'flowchart LR',
    ...nodes.map(n => `  ${ids.get(n.id)}["${label(n.label)}"]`),
    ...edges.map(e => `  ${ids.get(e.from)} ${e.certainty === 'CANDIDATE' ? '-.->' : '-->'}|${e.kind}| ${ids.get(e.to)}`),
    '```'].join('\n');
}
