// React invokes these methods through the component contract. Update/error/
// unmount callbacks are only possible paths: rendering alone does not execute them.
const lifecycle = new Set(['constructor', 'render', 'componentDidMount', 'componentDidUpdate',
  'componentWillUnmount', 'componentDidCatch', 'shouldComponentUpdate', 'getSnapshotBeforeUpdate',
  'getDerivedStateFromProps', 'getDerivedStateFromError', 'componentWillMount',
  'componentWillReceiveProps', 'componentWillUpdate', 'UNSAFE_componentWillMount',
  'UNSAFE_componentWillReceiveProps', 'UNSAFE_componentWillUpdate']);

export function linkReactLifecycle(files, incoming, addEdge) {
  for (const file of files) {
    if (!['ts', 'vue'].includes(file.lang)) continue;
    const bindings = (file.importBindings || []).filter((binding) => binding.source === 'react');
    if (!bindings.length) continue;
    for (const container of file.symbols) {
      if (container.kind !== 'class' || !(container.baseTypes || []).some((base) => bindings.some((binding) =>
        ['default', '*'].includes(binding.imported) ? [`${binding.local}.Component`, `${binding.local}.PureComponent`].includes(base)
          : ['Component', 'PureComponent'].includes(binding.imported) && base === binding.local))) continue;
      if (!(incoming.get(container.id) || []).some((edge) => edge.kind === 'REGISTRATION' && /^JSX /.test(edge.evidence?.reason || ''))) continue;
      for (const method of file.symbols) {
        if (method.parentContainerId !== container.id || !lifecycle.has(method.name)) continue;
        addEdge(container.id, method.id, { kind: 'REGISTRATION',
          evidence: { file: file.file, line: method.startLine,
            reason: `React 组件契约: ${container.name}.${method.name}（需挂载或对应生命周期条件）` },
          resolution: { mode: 'REACT_LIFECYCLE', confidence: ['constructor', 'render'].includes(method.name) ? 'HIGH' : 'MEDIUM' } });
      }
    }
  }
}
