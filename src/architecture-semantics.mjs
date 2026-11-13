// A typed static relationship must never silently become a runtime call.
export function relationshipSemantics(kind) {
  if (kind === 'SEQ_CALL' || kind === 'BRANCH_DISPATCH') return 'CONTROL_CALL';
  if (kind === 'PROTOCOL_BRIDGE') return 'PROTOCOL';
  if (kind === 'REGISTRATION') return 'REGISTRATION';
  if (kind === 'STATE_RW' || kind === 'STATE_READ' || kind === 'STATE_WRITE') return 'STATE';
  if (kind === 'CONTAINS' || kind === 'IMPLEMENTS') return 'STRUCTURAL';
  if (kind === 'IMPORT') return 'DEPENDENCY';
  return 'UNKNOWN';
}

export function isExecutableRelation(edge) {
  return ['CONTROL_CALL', 'PROTOCOL'].includes(relationshipSemantics(edge.kind)) &&
    (!edge.status || edge.status === 'CONNECTED');
}
