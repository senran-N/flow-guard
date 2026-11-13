import { classifyDomainLayer } from './arch-vision.mjs';
import { relationshipSemantics } from './architecture-semantics.mjs';
import { loadArchitectureGrouping } from './architecture-config.mjs';
import { architectureDependencies } from './architecture-dependencies.mjs';
import { architectureEvidence } from './architecture-evidence.mjs';

const fileId = file => `file:${file}`;
const symbolId = id => `symbol:${id}`;
const location = sym => ({ file: sym.file, line: sym.startLine, endLine: sym.endLine });

// This is a projection of static evidence, never a separate runtime reachability graph.
export function buildArchitectureProjection(graph, level, options = {}) {
  const grouping = loadArchitectureGrouping(graph);
  const { domainFor } = grouping;
  const moduleId = file => `module:${domainFor(file)}`;
  const nodes = new Map(), relations = new Map();
  const requestedEvidence = [];
  let collapsedInternalRelations = 0;
  const symbols = [...graph.symbolById.values()].filter(s => s.zone === 'prod');
  const symbolFiles = new Set(symbols.map(s => s.file));
  const prodFiles = graph.files.filter(f => f.zone === 'prod' || symbolFiles.has(f.file));
  const prodFilePaths = new Set(prodFiles.map(f => f.file));
  const project = sym => level === 'module' ? moduleId(sym.file) : level === 'file' ? fileId(sym.file) : symbolId(sym.id);
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id); };
  for (const f of prodFiles) {
    const domain = domainFor(f.file);
    const id = level === 'module' ? moduleId(f.file) : fileId(f.file);
    if (level !== 'symbol') {
      const node = addNode({ id, kind: level.toUpperCase(), label: level === 'module' ? domain : f.file,
        parentId: level === 'file' ? moduleId(f.file) : null,
        ...(level === 'module' ? grouping.describe(f.file) : { grouping: 'SOURCE_FILE' }),
        packages: [],
        filesCount: 0, symbolsCount: 0, roleDistribution: { sources: 0, branches: 0, sinks: 0 },
        runtimeEntryCount: 0, exportedSymbolCount: 0,
        drillDown: { tool: 'flow_overview', arguments: { level: level === 'module' ? 'file' : 'symbol', focus: id, depth: 0 } } });
      node.filesCount++;
      const pkg = grouping.packageFor(f.file);
      if (pkg && !node.packages.some(p => p.manifest === pkg.manifest)) node.packages.push(pkg);
    }
  }
  for (const sym of symbols) {
    const id = project(sym);
    if (level === 'symbol') addNode({ id, kind: 'SYMBOL', label: sym.parentContainerName ? `${sym.parentContainerName}.${sym.name}` : sym.name,
      parentId: fileId(sym.file), moduleId: moduleId(sym.file), package: grouping.packageFor(sym.file), location: location(sym), roles: sym.roles, exposure: sym.exposure,
      runtimeEntry: Boolean(sym.isEntrySource), exported: Boolean(sym.isPublicApi),
      runtimeReachability: graph.reachableFromRuntimeSource?.has(sym.id) ? 'STATIC_HIGH_CONFIDENCE_PATH'
        : graph.possiblyReachableFromRuntimeSource?.has(sym.id) ? 'STATIC_CANDIDATE_PATH' : 'NO_STATIC_PATH',
      drillDown: { tool: 'flow_trace', arguments: { target: sym.id } } });
    else {
      const node = nodes.get(id);
      node.symbolsCount++;
      node.runtimeEntryCount += sym.isEntrySource ? 1 : 0;
      node.exportedSymbolCount += sym.isPublicApi ? 1 : 0;
      for (const [role, key] of [['source', 'sources'], ['branch', 'branches'], ['sink', 'sinks']]) {
        if (sym.roles?.includes(role)) node.roleDistribution[key]++;
      }
    }
  }
  const dependencies = architectureDependencies(graph);
  if (level !== 'symbol') for (const dependency of dependencies.records) {
    const from = level === 'module' ? moduleId(dependency.file) : fileId(dependency.file);
    if (!nodes.has(from)) continue;
    const targets = dependency.targets.filter(file => prodFilePaths.has(file));
    if (!targets.length) {
      const status = dependency.targets.length ? 'OUTSIDE_PRODUCTION_SCOPE' : dependency.status;
      const id = `dependency:${JSON.stringify([dependency.file, dependency.specifier])}`;
      addNode({ id, kind: dependency.targets.length ? 'OUT_OF_SCOPE_DEPENDENCY' : 'UNRESOLVED_DEPENDENCY', label: dependency.specifier, status });
      addRelation(from, id, 'IMPORT', { file: dependency.file, line: dependency.line, specifier: dependency.specifier,
        form: dependency.form, reason: status, ...(dependency.targets.length ? { excludedTargets: dependency.targets } : {}) },
      { mode: 'JS_MODULE_SPECIFIER', confidence: 'MEDIUM' }, status);
    }
    for (const file of targets) addRelation(from, level === 'module' ? moduleId(file) : fileId(file), 'IMPORT',
      { file: dependency.file, line: dependency.line, specifier: dependency.specifier, form: dependency.form,
        reason: 'File dependency does not establish function execution' },
      { mode: 'JS_MODULE_SPECIFIER', confidence: targets.length === 1 ? 'HIGH' : 'AMBIGUOUS', ...(targets.length > 1 ? { candidates: targets } : {}) });
  }
  if (level === 'module') for (const node of nodes.values()) {
    if (node.kind !== 'MODULE') continue;
    node.layer = node.configuredLayer || classifyDomainLayer({ domain: node.label, totalSyms: node.symbolsCount,
      sourcesCount: node.roleDistribution.sources, branchesCount: node.roleDistribution.branches, sinksCount: node.roleDistribution.sinks });
    node.layerBasis = node.configuredLayer ? 'EXPLICIT_CONFIG' : 'DIRECTORY_AND_STATIC_ROLE_HEURISTIC';
  }
  function addRelation(from, to, kind, evidence, resolution = {}, status) {
    if (!nodes.has(from) || !nodes.has(to)) return;
    if (from === to && level !== 'symbol') { collapsedInternalRelations++; return; }
    const confidence = resolution.confidence || 'MEDIUM';
    const key = JSON.stringify([from, to, kind, confidence, status]);
    if (!relations.has(key)) relations.set(key, { id: `relation:${key}`, from, to, kind, confidence,
      certainty: confidence === 'HIGH' ? 'STATIC_EVIDENCE' : 'CANDIDATE',
      semantics: relationshipSemantics(kind),
      ...(status ? { status } : {}), evidenceCount: 0, evidence: [] });
    const relation = relations.get(key);
    relation.evidenceCount++;
    if (options.edgeId === relation.id && relation.evidenceCount > (options.evidenceOffset ?? 0) && requestedEvidence.length < (options.maxEvidence ?? 50)) {
      requestedEvidence.push({ ...evidence, resolution });
    }
    if (relation.evidence.length < 3) relation.evidence.push(architectureEvidence({ ...evidence, resolution }));
  }
  for (const sym of symbols) {
    for (const rec of graph.outEdgeDetails?.get(sym.id) || []) {
      const target = graph.symbolById.get(rec.toId);
      if (target?.zone !== 'prod') continue;
      addRelation(project(sym), project(target), rec.kind,
        { ...rec.evidence, source: location(sym), target: location(target) }, rec.resolution);
    }
  }
  // State ownership is shown explicitly even for write-only/read-only fields.
  if (level === 'symbol') {
    for (const [key, state] of graph.stateOwnership || []) {
      const writers = state.writers.filter(id => graph.symbolById.get(id)?.zone === 'prod');
      const readers = state.readers.filter(id => graph.symbolById.get(id)?.zone === 'prod');
      if (!writers.length && !readers.length) continue;
      const id = `state:${key}`;
      addNode({ id, kind: 'STATE', label: state.qualifiedField || state.field || key });
      for (const [ids, kind] of [[writers, 'STATE_WRITE'], [readers, 'STATE_READ']]) {
        for (const symId of ids) {
          const sym = graph.symbolById.get(symId);
          addRelation(kind === 'STATE_WRITE' ? symbolId(symId) : id, kind === 'STATE_WRITE' ? id : symbolId(symId), kind,
            { ...location(sym), locationKind: 'ENCLOSING_DECLARATION', stateField: state.qualifiedField || state.field,
              reason: 'Parsed state ownership; declaration location is not the exact field access location' },
            { mode: 'PARSED_STATE_OWNERSHIP', confidence: 'MEDIUM' });
        }
      }
    }
  }
  const symbolsByFile = new Map();
  for (const sym of symbols) {
    if (!symbolsByFile.has(sym.file)) symbolsByFile.set(sym.file, []);
    symbolsByFile.get(sym.file).push(sym);
  }
  for (const bridge of graph.crossBridges || []) {
    if (bridge.toFile) continue; // Connected bridges already have typed source evidence above.
    const sources = (symbolsByFile.get(bridge.fromFile) || []).filter(s => !bridge.fromSymbol || s.name === bridge.fromSymbol);
    const source = sources.find(s => s.startLine <= bridge.fromLine && s.endLine >= bridge.fromLine) || sources[0];
    const from = source ? project(source) : level === 'module' ? moduleId(bridge.fromFile) : fileId(bridge.fromFile);
    if (!nodes.has(from)) continue;
    const id = `endpoint:${JSON.stringify([bridge.kind, bridge.contract])}`;
    addNode({ id, kind: 'UNRESOLVED_ENDPOINT', label: bridge.contract, protocol: bridge.kind });
    addRelation(from, id, 'PROTOCOL_BRIDGE', { file: bridge.fromFile, line: bridge.fromLine,
      reason: 'No resolved protocol peer', contract: bridge.contract },
    { mode: 'PROTOCOL_CONTRACT', confidence: bridge.confidence || 'MEDIUM' }, bridge.status || 'UNRESOLVED');
  }

  return { graph, level, nodes, relations, symbols, prodFiles, project, domainFor, grouping, dependencies, requestedEvidence, collapsedInternalRelations };
}
