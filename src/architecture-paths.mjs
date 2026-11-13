import { buildArchitectureProjection } from './architecture-model.mjs';
import { resolveArchitectureFocus } from './architecture-focus.mjs';
import { isExecutableRelation } from './architecture-semantics.mjs';

export function pathQueryOptions(options = {}) {
  const result = { pathMode: options.pathMode ?? 'execution', maxHops: options.maxHops ?? 12,
    maxPaths: options.maxPaths ?? 5, searchBudget: options.searchBudget ?? 20000,
    includeCandidates: options.includeCandidates ?? false };
  if (!['execution', 'relationships'].includes(result.pathMode)) throw new TypeError('Invalid pathMode');
  if (typeof result.includeCandidates !== 'boolean') throw new TypeError('Invalid includeCandidates');
  for (const [key, max] of [['maxHops', 50], ['maxPaths', 50], ['searchBudget', 1000000]]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > max) throw new TypeError(`Invalid ${key}`);
  }
  return result;
}

// Breadth-first search returns shortest simple paths, not an unbounded enumeration.
export function findArchitecturePaths(graph, from, to, options = {}) {
  const query = pathQueryOptions(options);
  const model = buildArchitectureProjection(graph, 'symbol');
  const sources = resolveArchitectureFocus(model, from), targets = new Set(resolveArchitectureFocus(model, to));
  const edges = [...model.relations.values()].filter(e =>
    (query.includeCandidates || e.confidence === 'HIGH') &&
    (query.pathMode === 'relationships' || isExecutableRelation(e)));
  const adjacency = new Map();
  for (const e of edges.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e);
  }
  const queue = sources.sort().slice(0, query.searchBudget).map(id => ({ nodeIds: [id], edgeIds: [] }));
  const paths = [], selectedEdges = new Map(), selectedNodes = new Map();
  const byId = new Map(edges.map(e => [e.id, e]));
  let cursor = 0, work = 0, depthLimited = false, pathLimited = false, budgetLimited = sources.length > query.searchBudget;
  // Count queued states as work, including high fan-out at the first expansion.
  while (cursor < queue.length) {
    if (work >= query.searchBudget) { budgetLimited = true; break; }
    const current = queue[cursor++]; work++;
    const last = current.nodeIds.at(-1);
    if (targets.has(last)) {
      const candidate = current.edgeIds.some(id => byId.get(id).confidence !== 'HIGH');
      paths.push({ ...current, hops: current.edgeIds.length,
        certainty: candidate ? 'CANDIDATE' : 'STATIC_EVIDENCE', interpretation: query.pathMode === 'execution' ? 'STATIC_EXECUTION_PATH' : 'STATIC_RELATIONSHIP_PATH' });
      for (const id of current.nodeIds) selectedNodes.set(id, model.nodes.get(id));
      for (const id of current.edgeIds) selectedEdges.set(id, byId.get(id));
      if (paths.length >= query.maxPaths) { pathLimited = cursor < queue.length; break; }
      continue;
    }
    const next = (adjacency.get(last) || []).filter(e => !current.nodeIds.includes(e.to));
    if (current.edgeIds.length >= query.maxHops) { if (next.length) depthLimited = true; continue; }
    for (const edge of next) {
      if (queue.length >= query.searchBudget) { budgetLimited = true; break; }
      queue.push({ nodeIds: [...current.nodeIds, edge.to], edgeIds: [...current.edgeIds, edge.id] });
    }
  }
  return { query: { from, to, ...query }, status: paths.length ? 'PATHS_FOUND' : 'NO_STATIC_PATH_FOUND',
    paths, nodes: [...selectedNodes.values()], edges: [...selectedEdges.values()],
    search: { visitedStates: work, queuedStates: queue.length, depthLimited, pathLimited, budgetLimited,
      complete: !depthLimited && !pathLimited && !budgetLimited },
    limitations: ['Static paths do not prove runtime behavior or value propagation.',
      'No static path is not proof that endpoints are disconnected at runtime.',
      'Relationship mode may include registration, structural and state links; these are not executable calls.'] };
}
