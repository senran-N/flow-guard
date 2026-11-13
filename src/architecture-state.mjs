function stateOwners(graph, ids) {
  const unique = [...new Set(ids)];
  return unique.map(id => graph.symbolById.get(id)).filter(s => s?.zone === 'prod').sort((a, b) => a.id.localeCompare(b.id));
}

export function inspectArchitectureState(graph, query, options = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('State query must be nonempty');
  const maxStates = options.maxStates ?? 20, maxOwners = options.maxOwners ?? 30, stateOffset = options.stateOffset ?? 0;
  for (const [name, value, min, max] of [['maxStates', maxStates, 1, 200], ['maxOwners', maxOwners, 1, 500], ['stateOffset', stateOffset, 0, Number.MAX_SAFE_INTEGER]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
  }
  const input = query.startsWith('state:') ? query.slice(6) : query;
  const entries = [...graph.stateOwnership.entries()];
  const exact = entries.filter(([key, s]) => key === input || s.qualifiedField === input);
  const matches = (exact.length ? exact : entries.filter(([, s]) => s.field === input))
    .filter(([, s]) => [...s.writers, ...s.readers].some(id => graph.symbolById.get(id)?.zone === 'prod'))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const ref = sym => ({ id: `symbol:${sym.id}`, name: sym.name, file: sym.file, line: sym.startLine, endLine: sym.endLine,
    locationKind: 'ENCLOSING_DECLARATION', modulePath: sym.file.includes('/') ? sym.file.slice(0, sym.file.lastIndexOf('/')) : '(root)',
    persistenceHint: /^(?:save|serialize|persist|write|store)/i.test(sym.name) ? 'SAVE_NAME_HEURISTIC'
      : /^(?:load|deserialize|restore|read)/i.test(sym.name) ? 'LOAD_NAME_HEURISTIC' : null,
    runtimeReachability: graph.reachableFromRuntimeSource?.has(sym.id) ? 'STATIC_HIGH_CONFIDENCE_PATH' : 'NO_STATIC_HIGH_CONFIDENCE_PATH',
    inspect: { tool: 'flow_trace', arguments: { ...(graph.workspaceRoot ? { workspaceRoot: graph.workspaceRoot } : {}), target: sym.id } } });
  const states = matches.slice(stateOffset, stateOffset + maxStates).map(([key, state]) => {
    const writers = stateOwners(graph, state.writers), readers = stateOwners(graph, state.readers);
    return { id: `state:${key}`, key, field: state.field, qualifiedField: state.qualifiedField || state.field, scope: state.scope ?? null,
      writers: writers.slice(0, maxOwners).map(ref), readers: readers.slice(0, maxOwners).map(ref),
      classification: writers.length && readers.length ? 'READ_AND_WRITTEN' : writers.length ? 'WRITE_ONLY_STATIC_EVIDENCE' : 'READ_ONLY_STATIC_EVIDENCE',
      coverage: { writers: writers.length, readers: readers.length, omittedWriters: Math.max(0, writers.length - maxOwners), omittedReaders: Math.max(0, readers.length - maxOwners) },
      lifecycleFindings: (graph.fieldLifecycleAsymmetries || []).filter(f => f.qualifiedField === (state.qualifiedField || key)),
      view: { tool: 'flow_overview', arguments: { ...(graph.workspaceRoot ? { workspaceRoot: graph.workspaceRoot } : {}), level: 'symbol', focus: `state:${key}`, depth: 1 } }
    };
  });
  return { query, status: matches.length > 1 ? 'AMBIGUOUS_STATE' : matches.length ? 'STATE_FOUND' : 'NO_STATIC_STATE_FOUND', states,
    coverage: { matched: matches.length, returned: states.length, omitted: matches.length - states.length,
      nextStateOffset: stateOffset + states.length < matches.length ? stateOffset + states.length : null },
    limitations: ['Owners are parsed static read/write evidence, not proof that a value affects the final output.',
      'Persistence hints use method names and do not prove a successful save/reload cycle.',
      'State access locations refer to enclosing declarations; unresolved aliases and dynamic keys may be absent.'] };
}
