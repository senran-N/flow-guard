import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceFileContent } from '../src/file-parser.mjs';
import { assembleFlowGraph } from '../src/graph-builder.mjs';

const files = (source) => [
  parseSourceFileContent(source, 'backend/app/api/routes/users.py'),
  parseSourceFileContent('def authorize():\n    return True\n', 'backend/app/api/deps.py'),
  parseSourceFileContent('def authorize():\n    return True\n', 'unrelated/app/api/deps.py')
];
const imported = 'from fastapi import APIRouter, Depends as Inject\nfrom app.api.deps import (\n authorize as check_user,\n)\nrouter = APIRouter()\n';
const edges = (graph) => [...graph.outEdgeDetails.values()].flat().filter((edge) => edge.resolution.mode === 'FASTAPI_DEPENDENCY');

test('FastAPI route dependencies connect exact imported aliases across multiline decorators', () => {
  const source = imported + '@router.get(\n "/users",\n dependencies=[Inject(check_user)],\n)\ndef read_users():\n return []\n';
  const graph = assembleFlowGraph(files(source), '', { projectMode: 'application' });
  const found = edges(graph);
  assert.equal(found.length, 1);
  assert.equal(graph.symbolById.get(found[0].toId).file, 'backend/app/api/deps.py');
  assert.equal(found[0].evidence.line, 8);
  assert.ok(graph.reachableFromRuntimeSource.has(found[0].toId));
});

test('removing the FastAPI dependency or replacing its import removes the framework edge', () => {
  for (const source of [
    imported + '@router.get("/users")\ndef read_users():\n return []\n',
    imported.replace('from fastapi import', 'from unrelated import') + '@router.get("/users", dependencies=[Inject(check_user)])\ndef read_users():\n return []\n',
    imported + 'def Inject(value):\n return value\n@router.get("/users", dependencies=[Inject(check_user)])\ndef read_users():\n return []\n',
    imported + '# @router.get("/users", dependencies=[Inject(check_user)])\ndef read_users():\n return []\n'
  ]) assert.equal(edges(assembleFlowGraph(files(source), '', { projectMode: 'application' })).length, 0);
});
