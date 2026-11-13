import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceFileContent } from "../src/file-parser.mjs";
import { assembleFlowGraph } from "../src/graph-builder.mjs";

const imported = `from fastapi import APIRouter, Depends as Inject
from app.api.deps import authorize as check_user
router = APIRouter()
`;

function dependencyEdges(source) {
  const graph = assembleFlowGraph([
    parseSourceFileContent(source, "backend/app/api/routes/users.py"),
    parseSourceFileContent("def authorize():\n return True\n", "backend/app/api/deps.py")
  ], "", { projectMode: "application" });
  return [...graph.outEdgeDetails.values()].flat().filter((edge) => edge.resolution.mode === "FASTAPI_DEPENDENCY");
}

test("local dependency shadow resolves to the local function, not its import", () => {
  const edges = dependencyEdges(imported + `def check_user():
 return False
@router.get("/users", dependencies=[Inject(check_user)])
def endpoint():
 return []
`);
  assert.equal(edges.length, 1);
  const graph = assembleFlowGraph([
    parseSourceFileContent(imported + `def check_user():
 return False
@router.get("/users", dependencies=[Inject(check_user)])
def endpoint():
 return []
`, "backend/app/api/routes/users.py"),
    parseSourceFileContent("def authorize():\n return True\n", "backend/app/api/deps.py")
  ], "", { projectMode: "application" });
  assert.equal(graph.symbolById.get(edges[0].toId).file, "backend/app/api/routes/users.py");
});

test("reassigned router no longer supplies FastAPI route evidence", () => {
  const edges = dependencyEdges(imported + `router = object()
@router.get("/users", dependencies=[Inject(check_user)])
def endpoint():
 return []
`);
  assert.equal(edges.length, 0);
});

test("Depends in a second non-route decorator is not treated as route dependency", () => {
  const edges = dependencyEdges(imported + `@router.get("/users")
@cache(Inject(check_user))
def endpoint():
 return []
`);
  assert.equal(edges.length, 0);
});

test("actual route decorator dependency remains connected among stacked decorators", () => {
  const edges = dependencyEdges(imported + `@cache()
@router.get("/users", dependencies=[Inject(check_user)])
def endpoint():
 return []
`);
  assert.equal(edges.length, 1);
});
