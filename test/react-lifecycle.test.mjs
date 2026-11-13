import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceFileContent } from '../src/file-parser.mjs';
import { assembleFlowGraph } from '../src/graph-builder.mjs';

function graph({ imports = "import R from 'react';", base = 'R.Component', rendered = true } = {}) {
  return assembleFlowGraph([
    parseSourceFileContent(`${imports}\nexport default class Editor extends ${base} {\n  render() {\n    return <div />;\n  }\n  componentDidMount() {\n    console.log('mounted');\n  }\n  arbitraryMethod() {\n    console.log('unused');\n  }\n}`, 'src/Editor.jsx'),
    parseSourceFileContent(`import Editor from './Editor.jsx';\n${rendered ? 'render(<Editor />);' : 'console.log("no rendering");'}`, 'src/main.jsx')
  ], '', { projectMode: 'application' });
}

test('rendered React class lifecycle has source evidence without claiming callbacks executed', () => {
  for (const input of [{}, { imports: "import { Component as Base } from 'react';", base: 'Base' },
    { imports: "import * as React from 'react';", base: 'React.PureComponent' }]) {
    const result = graph(input);
    const methods = [...result.symbolById.values()].filter((s) => s.parentContainerName === 'Editor');
    const render = methods.find((s) => s.name === 'render');
    const mount = methods.find((s) => s.name === 'componentDidMount');
    const other = methods.find((s) => s.name === 'arbitraryMethod');
    assert.ok(result.reachableFromRuntimeSource.has(render.id));
    assert.ok(result.possiblyReachableFromRuntimeSource.has(mount.id));
    assert.ok(!result.reachableFromRuntimeSource.has(mount.id));
    assert.ok(!result.possiblyReachableFromRuntimeSource.has(other.id));
    assert.ok(result.inEdgeDetails.get(mount.id).some((e) => e.resolution.mode === 'REACT_LIFECYCLE' && e.evidence.line === mount.startLine));
  }
});

test('no React contract is inferred from a same-named unrelated base or an unrendered class', () => {
  for (const input of [{ imports: "import R from './unrelated.js';" }, { rendered: false }]) {
    const result = graph(input);
    assert.ok(![...result.inEdgeDetails.values()].flat().some((e) => e.resolution.mode === 'REACT_LIFECYCLE'));
  }
});
