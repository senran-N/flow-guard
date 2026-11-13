import { resolveArchitectureFocus } from './architecture-focus.mjs';
import { relationshipSemantics } from './architecture-semantics.mjs';

function adjacency(model, candidates = false) {
  const forward = new Map([...model.nodes.keys()].map(id => [id, new Set()]));
  const reverse = new Map([...model.nodes.keys()].map(id => [id, new Set()]));
  for (const edge of model.relations.values()) {
    if ((!candidates && edge.confidence !== 'HIGH') || ['STRUCTURAL', 'STATE', 'UNKNOWN'].includes(relationshipSemantics(edge.kind))) continue;
    if (edge.status && edge.status !== 'CONNECTED') continue;
    forward.get(edge.from).add(edge.to); reverse.get(edge.to).add(edge.from);
  }
  return { forward, reverse };
}

export function summarizeArchitectureTopology(model) {
  const { forward, reverse } = adjacency(model);
  // Iterative Kosaraju avoids recursion failure on deep dependency chains.
  const visited = new Set(), finish = [];
  for (const id of forward.keys()) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [{ id, iterator: forward.get(id).values() }];
    while (stack.length) {
      const frame = stack.at(-1), next = frame.iterator.next();
      if (next.done) { finish.push(frame.id); stack.pop(); }
      else if (!visited.has(next.value)) { visited.add(next.value); stack.push({ id: next.value, iterator: forward.get(next.value).values() }); }
    }
  }
  visited.clear();
  const cycles = [];
  for (let i = finish.length - 1; i >= 0; i--) {
    const id = finish[i];
    if (visited.has(id)) continue;
    const component = [], stack = [id]; visited.add(id);
    while (stack.length) {
      const next = stack.pop(); component.push(next);
      for (const prev of reverse.get(next)) if (!visited.has(prev)) { visited.add(prev); stack.push(prev); }
    }
    if (component.length > 1 || forward.get(id).has(id)) cycles.push(component.sort());
  }
  cycles.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const sourceNodes = [...model.nodes.values()].filter(n => ['MODULE', 'FILE', 'SYMBOL'].includes(n.kind));
  const isolated = sourceNodes.filter(n => !forward.get(n.id).size && !reverse.get(n.id).size).map(n => n.id).sort();
  const hubs = sourceNodes.map(n => ({ id: n.id, inbound: reverse.get(n.id).size, outbound: forward.get(n.id).size }))
    .sort((a, b) => b.inbound + b.outbound - a.inbound - a.outbound || a.id.localeCompare(b.id));
  return { basis: 'HIGH_CONFIDENCE_STATIC_DEPENDENCIES', scope: 'FULL_PROJECTION_BEFORE_FOCUS_AND_PAGINATION',
    counts: { nodes: model.nodes.size, cycles: cycles.length, isolatedSourceNodes: isolated.length },
    cycles: cycles.slice(0, 20).map(ids => ({ nodeIds: ids.slice(0, 40), totalNodes: ids.length, omittedNodes: Math.max(0, ids.length - 40) })),
    isolatedSourceNodes: isolated.slice(0, 40), hubs: hubs.slice(0, 20),
    omitted: { cycles: Math.max(0, cycles.length - 20), isolatedSourceNodes: Math.max(0, isolated.length - 40), hubs: Math.max(0, hubs.length - 20) },
    limitations: ['Dependency cycles and isolated static nodes are review clues, not proven defects.',
      'Coarse module/file projection merges distinct symbols and may form dependency cycles absent from the executable call graph.'] };
}

export function inspectArchitectureImpact(model, focus, options = {}) {
  const seeds = resolveArchitectureFocus(model, focus);
  const maxHops = options.maxHops ?? 12, limit = options.impactLimit ?? 100;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 50 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid impact bounds');
  const walk = (candidates, direction) => {
    const links = adjacency(model, candidates)[direction];
    const found = new Map(seeds.map(id => [id, { id, hops: 0, via: null }])), queue = [...seeds];
    let depthLimited = false;
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i], depth = found.get(id).hops;
      for (const next of links.get(id)) {
        if (found.has(next)) continue;
        if (depth >= maxHops) { depthLimited = true; continue; }
        found.set(next, { id: next, hops: depth + 1, via: id }); queue.push(next);
      }
    }
    const results = [...found.values()].filter(n => n.hops).sort((a, b) => a.hops - b.hops || a.id.localeCompare(b.id));
    return { results, depthLimited };
  };
  const format = direction => {
    const high = walk(false, direction), possible = walk(true, direction), highIds = new Set(high.results.map(n => n.id));
    const candidates = possible.results.filter(n => !highIds.has(n.id));
    return { highConfidence: high.results.slice(0, limit), candidateOnly: candidates.slice(0, limit),
      coverage: { highConfidence: high.results.length, candidateOnly: candidates.length,
        omittedHighConfidence: Math.max(0, high.results.length - limit), omittedCandidateOnly: Math.max(0, candidates.length - limit),
        depthLimited: high.depthLimited || possible.depthLimited } };
  };
  return { focus, seedIds: seeds, upstream: format('reverse'), downstream: format('forward'),
    limitations: ['Dependency impact includes registration and import relationships, not proof of runtime execution.',
      'Candidate-only paths remain uncertain. State owners are queried separately with inspectState.'] };
}
