export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
  "payload",
  "release",
  ".work",
  ".gemini",
  ".vscode",
  ".idea",
  "coverage",
  "__pycache__",
  "website",
  "site",
  "gh-pages",
  "third_party",
  "vendor",
  "external",
  "artifacts"
]);

export const EXT_LANG = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".vue": "vue",
  ".svelte": "vue",
  ".rs": "rust",
  ".cs": "csharp",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".dart": "java",
  ".php": "php",
  ".c": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".cu": "cpp",
  ".cuh": "cpp"
};

const CONTROL_KEYWORDS =
  /^(if|else|for|foreach|while|switch|case|catch|using|lock|return|throw|new|await|async|super|base|this|typeof|sizeof|nameof|checked|unchecked|fixed|synchronized|assert|yield|import|require|readonly|record|struct|class|interface|enum|delegate|event|operator)$/;

const GO_BUILTIN_TYPES =
  /^(int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|float32|float64|complex64|complex128|byte|rune|string|bool|error|any)$/;

function stripLeadingAttributesAndAnnotations(raw) {
  let s = raw.trim();
  // Strip C# `[Attr(...)]` or `[Attr]`
  while (s.startsWith("[")) {
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "[") depth++;
      else if (s[i] === "]") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx >= 0) {
      s = s.slice(endIdx + 1).trim();
    } else {
      break;
    }
  }
  // Strip Java/TS `@Annotation(...)` or `@Annotation`
  while (s.startsWith("@")) {
    s = s.replace(/^@[A-Za-z0-9_$.]+(?:\s*\([^)]*\))?\s*/, "").trim();
  }
  return s;
}

function splitTopLevelByChar(str, sepChar) {
  const parts = [];
  let paren = 0;
  let angle = 0;
  let bracket = 0;
  let brace = 0;
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : "";
    if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]" && bracket > 0) bracket--;
    else if (ch === "{") brace++;
    else if (ch === "}" && brace > 0) brace--;
    else if (paren === 0 && bracket === 0 && brace === 0) {
      if (ch === "<") angle++;
      else if (ch === ">" && prev !== "-" && prev !== "=" && angle > 0) angle--;
      else if (angle === 0 && ch === sepChar) {
        parts.push(str.slice(last, i));
        last = i + 1;
      }
    }
  }
  parts.push(str.slice(last));
  return parts;
}

function cleanParamName(rawParam, lang, hasTypedSubsequentParam = false) {
  let s = rawParam.trim();
  if (!s || s === "*" || s === "/") return null;

  // For JS/TS/Rust array/object/tuple destructuring, skip before stripping `[...]`
  if ((lang === "ts" || lang === "vue" || lang === "rust") && (s.startsWith("{") || s.startsWith("[") || s.startsWith("("))) {
    return null;
  }

  s = stripLeadingAttributesAndAnnotations(s);
  if (!s || s === "self" || s === "&self" || s === "&mut self" || s === "mut self" || s === "this") return null;

  // Strip top-level default value `= ...`
  s = splitTopLevelByChar(s, "=")[0].trim();
  if (!s || s.startsWith("{") || s.startsWith("[") || s.startsWith("(")) return null;

  if (lang === "php") {
    const phpM = s.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
    return phpM ? phpM[1] : null;
  }

  if (
    lang === "ts" ||
    lang === "vue" ||
    lang === "rust" ||
    lang === "python" ||
    lang === "ruby" ||
    lang === "kotlin" ||
    lang === "swift"
  ) {
    const lhs = splitTopLevelByChar(s, ":")[0].trim();
    if (!lhs || lhs.includes("(") || lhs.includes("{") || lhs.includes("[")) return null;
    const colonParts = lhs.split(/\s+/);
    const candidate = colonParts[colonParts.length - 1]
      .replace(/^(?:\.\.\.|\*\*|\*|[&?])+/, "")
      .replace(/[?:]$/, "");
    if (candidate === "self" || candidate === "this" || candidate === "cls") return null;
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(candidate) ? candidate : null;
  }

  // Go (`name Type`, `name ...Type`, or shared-type `user, password string`)
  if (lang === "go") {
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const candidate = tokens[0];
      return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate) ? candidate : null;
    }
    if (tokens.length === 1 && hasTypedSubsequentParam) {
      const candidate = tokens[0];
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate) && !GO_BUILTIN_TYPES.test(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  // C#, Java, C++ (`[Modifiers] Type name`)
  let cleaned = s
    .replace(/\b(?:this|ref|out|in|params|scoped|final|readonly|const|constexpr|volatile|mutable|register|restrict)\b/g, " ")
    .trim();
  if (lang === "cpp") {
    cleaned = cleaned.replace(/(?:\s+[A-Z][A-Z0-9_]{2,})+$/, "").trim();
  }
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const candidate = tokens[tokens.length - 1]
      .replace(/^[&*]+/, "")
      .replace(/(?:\[\d*\])+$/, "");
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate) ? candidate : null;
  }
  return null;
}

export function extractParamNames(lang, sigText) {
  let inner = sigText.trim();
  if (inner.startsWith("(") && inner.endsWith(")")) {
    inner = inner.slice(1, -1).trim();
  } else {
    const openIdx = inner.indexOf("(");
    const closeIdx = inner.lastIndexOf(")");
    if (openIdx < 0 || closeIdx <= openIdx) return [];
    inner = inner.slice(openIdx + 1, closeIdx).trim();
  }
  if (!inner) return [];

  const rawList = splitTopLevelByChar(inner, ",");
  const names = [];
  for (let i = 0; i < rawList.length; i++) {
    let hasTypedNext = false;
    if (lang === "go") {
      for (let j = i + 1; j < rawList.length; j++) {
        if (rawList[j].trim().split(/\s+/).length >= 2) {
          hasTypedNext = true;
          break;
        }
      }
    }
    const clean = cleanParamName(rawList[i], lang, hasTypedNext);
    if (clean && !clean.startsWith("_")) names.push(clean);
  }
  return names;
}

export function extractPromotedParamNames(lang, sigText) {
  if (lang !== "ts" && lang !== "vue" && lang !== "php") return [];
  let inner = sigText.trim();
  if (inner.startsWith("(") && inner.endsWith(")")) {
    inner = inner.slice(1, -1).trim();
  } else {
    const openIdx = inner.indexOf("(");
    const closeIdx = inner.lastIndexOf(")");
    if (openIdx < 0 || closeIdx <= openIdx) return [];
    inner = inner.slice(openIdx + 1, closeIdx).trim();
  }
  if (!inner) return [];

  const rawList = splitTopLevelByChar(inner, ",");
  const promoted = [];
  for (const raw of rawList) {
    const beforeDefault = splitTopLevelByChar(stripLeadingAttributesAndAnnotations(raw.trim()), "=")[0].trim();
    const headerPart = lang === "php" ? beforeDefault : splitTopLevelByChar(beforeDefault, ":")[0].trim();
    if (/\b(?:public|private|protected|readonly|override)\b/.test(headerPart)) {
      const clean = cleanParamName(raw, lang, false);
      if (clean && !clean.startsWith("_")) promoted.push(clean);
    }
  }
  return promoted;
}

export function matchSymbolDeclaration(lang, line, inClassScope = false) {
  if (lang === "csharp" || lang === "java" || lang === "kotlin") {
    const classM = line.match(
      /^\s*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|final|open|data|readonly|ref)\s+)*(class|struct|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/
    );
    if (classM) {
      return {
        name: classM[2],
        kind: "class",
        isInterface: classM[1] === "interface",
        isPublicApi: /\bpublic\b/.test(line)
      };
    }

    if (lang === "kotlin") {
      const ktM = line.match(/^\s*(?:(?:public|internal|private|protected|override|open|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[A-Za-z_][A-Za-z0-9_<>,.?]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (ktM) return { name: ktM[1], kind: "method", isPublicApi: !/\b(private|internal)\b/.test(line) };
    }

    // Constructor (`public Foo(` or `private Foo(`)
    const ctorM = line.match(/^\s*(?:public|internal|private|protected)\s+([A-Z][A-Za-z0-9_]*)\s*\(/);
    if (ctorM && !CONTROL_KEYWORDS.test(ctorM[1])) {
      return {
        name: ctorM[1],
        kind: "method",
        isConstructor: true,
        isPublicApi: /\bpublic\b/.test(line)
      };
    }

    // Reject lines that have `=` before `(` (variable assignments / lambdas / default properties)
    const firstParen = line.indexOf("(");
    if (firstParen < 0) return null;
    const prefixBeforeParen = line.slice(0, firstParen);
    if (prefixBeforeParen.includes("=") || prefixBeforeParen.includes(";") || /\b(?:return|throw|new|await|case)\b/.test(prefixBeforeParen)) {
      return null;
    }

    // Match C#/Java methods (including generic `<T>`, wildcard generics `List<? extends Foo>`, package-private, `default`, tuple returns, and explicit interface implementations)
    const methodM = line.match(
      /^\s*(?:@[A-Za-z0-9_$.]+(?:\([^)]*\))?\s*)*(?:(?:public|internal|private|protected|static|virtual|override|abstract|async|synchronized|final|default|native|extern|unsafe|new|sealed|partial|readonly)\s+)*(?:<[^>{;()]+\>\s+)?(?:@[A-Za-z0-9_$.]+(?:\([^)]*\))?\s*)*(?:[A-Za-z_][A-Za-z0-9_<>,.?\[\]&*]*(?:<[^>{;()]+>[A-Za-z0-9_.\[\]&*?]*)?|\([A-Za-z0-9_<>,.?\[\]\s]+\))\s+(?:[A-Za-z_][A-Za-z0-9_<>.]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{;()]+>\s*)?\(/
    );
    if (methodM && !CONTROL_KEYWORDS.test(methodM[1])) {
      const isPublic = /\bpublic\b/.test(prefixBeforeParen) || (lang === "java" && /\bdefault\b/.test(prefixBeforeParen));
      const isOverride = /\boverride\b/.test(prefixBeforeParen);
      return {
        name: methodM[1],
        kind: "method",
        isPublicApi: isPublic,
        isOverride
      };
    }
    return null;
  }

  if (lang === "rust") {
    const fnM = line.match(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:unsafe\s+)?(?:async\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/
    );
    if (fnM) {
      const isPub = /^\s*pub(?:\s|\()/.test(line);
      return { name: fnM[1], kind: "function", isPublicApi: isPub };
    }
    const stM = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (stM) {
      return {
        name: stM[2],
        kind: "struct",
        isTrait: stM[1] === "trait",
        isPublicApi: /^\s*pub(?:\s|\()/.test(line)
      };
    }
    if (/^\s*(?:unsafe\s+)?impl\b/.test(line) && !line.includes(";")) {
      const beforeBrace = line.split("{")[0].split(/\bwhere\b/)[0];
      const isTraitImpl = /\bfor\b/.test(beforeBrace);
      const afterFor = isTraitImpl ? beforeBrace.split(/\bfor\b/).pop() : beforeBrace;
      const typeMatches = afterFor.replace(/<[^>]*>/g, "").match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (typeMatches && typeMatches[1] !== "impl") {
        return { name: typeMatches[1], kind: "impl", isTraitImpl, isPublicApi: false };
      }
    }
    return null;
  }

  if (lang === "ts" || lang === "vue") {
    const clsM = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (clsM) {
      return { name: clsM[1], kind: "class", isPublicApi: /^\s*export\b/.test(line) };
    }

    const fnM =
      line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[<(]/) ||
      line.match(
        /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:<[^>]*>\s*)?\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+)?=>|[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>)/
      );
    if (fnM) {
      return { name: fnM[1], kind: "function", isPublicApi: /^\s*export\b/.test(line) };
    }

    if (inClassScope) {
      const firstParen = line.indexOf("(");
      if (firstParen > 0) {
        const beforeParen = line.slice(0, firstParen);
        if (!beforeParen.includes("=") && !beforeParen.includes(";") && !beforeParen.includes(".")) {
          const mthM = line.match(
            /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(#?[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>{;()]*>\s*)?\(/
          );
          if (mthM && !CONTROL_KEYWORDS.test(mthM[1])) {
            const name = mthM[1];
            const isPrivate = name.startsWith("#") || name.startsWith("_") || /\bprivate\b/.test(beforeParen);
            return {
              name: name === "constructor" ? "constructor" : name,
              kind: "method",
              isConstructor: name === "constructor",
              isPublicApi: !isPrivate
            };
          }
        }
      }
      const arrowMthM = line.match(
        /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:<[^>]*>\s*)?\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+)?=>|[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>)/
      );
      if (arrowMthM && !CONTROL_KEYWORDS.test(arrowMthM[1])) {
        const name = arrowMthM[1];
        const beforeEq = line.slice(0, line.indexOf("="));
        const isPrivate = name.startsWith("#") || name.startsWith("_") || /\bprivate\b/.test(beforeEq);
        return {
          name,
          kind: "method",
          isConstructor: false,
          isPublicApi: !isPrivate
        };
      }
    }
    return null;
  }

  if (lang === "swift") {
    const extM = line.match(/^\s*(?:(?:public|internal|private|fileprivate)\s+)?extension\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (extM) {
      return { name: extM[1], kind: "impl", isTraitImpl: line.includes(":"), isPublicApi: false };
    }
    const clsM = line.match(
      /^\s*(?:(?:public|open|internal|private|fileprivate|final|indirect)\s+)*(class|struct|enum|actor|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/
    );
    if (clsM) {
      return {
        name: clsM[2],
        kind: "class",
        isInterface: clsM[1] === "protocol",
        isPublicApi: !/\b(?:private|fileprivate)\b/.test(line)
      };
    }
    const initM = line.match(/^\s*(?:(?:public|open|internal|private|fileprivate|convenience|required|override)\s+)*init[?!]?\s*\(/);
    if (initM) {
      const beforeInit = line.slice(0, line.indexOf("("));
      return {
        name: "init",
        kind: "method",
        isConstructor: true,
        isPublicApi: !/\b(?:private|fileprivate)\b/.test(beforeInit)
      };
    }
    const fnM = line.match(
      /^\s*(?:(?:public|open|internal|private|fileprivate|static|class|override|mutating|nonmutating|async)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/
    );
    if (fnM) {
      const beforeFn = line.slice(0, line.search(/\bfunc\b/));
      return {
        name: fnM[1],
        kind: inClassScope ? "method" : "function",
        isPublicApi: !/\b(?:private|fileprivate)\b/.test(beforeFn),
        isOverride: /\boverride\b/.test(beforeFn)
      };
    }
    return null;
  }

  if (lang === "php") {
    const clsM = line.match(/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (clsM) {
      return {
        name: clsM[2],
        kind: "class",
        isInterface: clsM[1] === "interface" || clsM[1] === "trait",
        isPublicApi: true
      };
    }
    const fnM = line.match(
      /^\s*(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/
    );
    if (fnM) {
      const name = fnM[1];
      const beforeFn = line.slice(0, line.search(/\bfunction\b/));
      return {
        name,
        kind: inClassScope ? "method" : "function",
        isConstructor: name === "__construct",
        isPublicApi: !/\bprivate\b/.test(beforeFn)
      };
    }
    return null;
  }

  if (lang === "ruby") {
    const defM = line.match(/^(\s*)def\s+(?:self\.)?([a-zA-Z_][a-zA-Z0-9_!?=]*)/);
    if (defM) {
      const name = defM[2];
      return {
        name,
        kind: defM[1].length > 0 ? "method" : "function",
        indent: defM[1].length,
        isConstructor: name === "initialize",
        isPublicApi: !name.startsWith("_")
      };
    }
    const clsM = line.match(/^(\s*)(?:class|module)\s+(?:[A-Za-z0-9_]+::)*([A-Z][A-Za-z0-9_]*)/);
    if (clsM) {
      return {
        name: clsM[2],
        kind: "class",
        indent: clsM[1].length,
        isPublicApi: true
      };
    }
    return null;
  }

  if (lang === "python") {
    const defM = line.match(/^(\s*)(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (defM) {
      const name = defM[2];
      return {
        name,
        kind: defM[1].length > 0 ? "method" : "function",
        indent: defM[1].length,
        isPublicApi: !name.startsWith("_") || name === "__init__" || name === "__call__"
      };
    }
    const clsM = line.match(/^(\s*)class\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (clsM) {
      return {
        name: clsM[2],
        kind: "class",
        indent: clsM[1].length,
        isPublicApi: !clsM[2].startsWith("_")
      };
    }
    return null;
  }

  if (lang === "go") {
    const recvM = line.match(
      /^\s*func\s+\(\s*(?:[a-zA-Z_][a-zA-Z0-9_]*\s+)?\*?([a-zA-Z_][a-zA-Z0-9_]*)(?:\[[^\]]*\])?\s*\)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[(\[]/
    );
    if (recvM) {
      return {
        name: recvM[2],
        kind: "method",
        receiverType: recvM[1],
        isPublicApi: /^[A-Z]/.test(recvM[2])
      };
    }
    const goM =
      line.match(/^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(\[]/) ||
      line.match(/^\s*var\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*func\s*\(/);
    if (goM) {
      return { name: goM[1], kind: "function", isPublicApi: /^[A-Z]/.test(goM[1]) };
    }
    const stM = line.match(/^\s*type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(struct|interface)\b/);
    if (stM) {
      return {
        name: stM[1],
        kind: "struct",
        isInterface: stM[2] === "interface",
        isPublicApi: /^[A-Z]/.test(stM[1])
      };
    }
    return null;
  }

  if (lang === "cpp") {
    const clsM = line.match(
      /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Z][A-Z0-9_]*\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:final\s*)?(?::[^{;]+|\{|$)/
    );
    if (clsM && !line.includes(";")) {
      return { name: clsM[1], kind: "struct", isPublicApi: true };
    }
    const firstParen = line.indexOf("(");
    if (firstParen < 0) return null;
    const beforeParen = line.slice(0, firstParen);
    if (beforeParen.includes("=") || beforeParen.includes(";") || /\b(?:return|throw|new|case|else)\b/.test(beforeParen)) {
      return null;
    }
    const qualM = line.match(
      /^\s*(?:[A-Za-z_][A-Za-z0-9_:*&<>]*\s+)*([A-Za-z_][A-Za-z0-9_]*)(?:<[^>{;()]*>)?::(~?[A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$/
    );
    if (qualM && !CONTROL_KEYWORDS.test(qualM[2])) {
      return {
        name: qualM[2],
        kind: "method",
        receiverType: qualM[1],
        isConstructor: qualM[1] === qualM[2],
        isPublicApi: true
      };
    }
    if (inClassScope) {
      const ctorM = line.match(
        /^\s*(?:(?:explicit|constexpr|inline|virtual|friend)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$/
      );
      if (ctorM && !CONTROL_KEYWORDS.test(ctorM[1])) {
        return {
          name: ctorM[1],
          kind: "method",
          isConstructor: true,
          isPublicApi: true
        };
      }
    }
    const cppM = line.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_:*&<>]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$/);
    if (cppM && !CONTROL_KEYWORDS.test(cppM[1])) {
      return {
        name: cppM[1],
        kind: inClassScope ? "method" : "function",
        isPublicApi: true
      };
    }
  }

  return null;
}

/**
 * Runtime entry binding detection (Application entry points, IPC/HTTP handlers, framework lifecycle hooks).
 */
export function isRuntimeEntrySource(lang, fileRel, symName, attrsAndSig, bodyText, fileHasUnityOrHarmony = false) {
  const normFile = fileRel.replace(/\\/g, "/");

  if (lang === "csharp") {
    if (symName === "Main" || /\[Harmony(Patch|Prefix|Postfix|Transpiler)/.test(attrsAndSig)) {
      return true;
    }
    if (fileHasUnityOrHarmony && /^(Awake|Start|Update|FixedUpdate|LateUpdate|OnGUI|OnDestroy|Prefix|Postfix|Transpiler)$/.test(symName)) {
      return true;
    }
    if (/\[(HttpGet|HttpPost|HttpPut|HttpDelete|Route|ApiController)\]/.test(attrsAndSig)) {
      return true;
    }
    return false;
  }
  if (lang === "rust") {
    return (
      symName === "main" ||
      symName === "run" ||
      /#\[(?:tauri::)?command\s*\]|#\[specta::specta\b/.test(attrsAndSig) ||
      /#\[(get|post|put|delete|patch|tokio::main|actix_web::main)\]/.test(attrsAndSig) ||
      (/(^|\/)lib\.rs$/.test(normFile) && /^\s*pub\s+fn\b/.test(attrsAndSig))
    );
  }
  if (lang === "ts" || lang === "vue") {
    return (
      symName === "main" ||
      symName === "fetch" ||
      normFile.endsWith("App.vue") ||
      normFile.endsWith("App.svelte") ||
      (/(^|\/)index\.(ts|tsx|js|mjs)$/.test(normFile) && /\bexport\b/.test(attrsAndSig)) ||
      /(^|\/)app\/.*\/(page|route)\.(tsx|ts|js)$/.test(normFile) ||
      /@(click|submit|change|input|keydown)|on(Click|Submit|Change)\s*=/.test(bodyText) ||
      /ipcMain\.(handle|on)\s*\(|process\.stdin\.on\s*\(/.test(bodyText)
    );
  }
  if (lang === "swift") {
    return (
      symName === "main" ||
      /@main\b|@UIApplicationMain\b|@IBAction\b/.test(attrsAndSig) ||
      /^(viewDidLoad|application|scene|body)$/.test(symName)
    );
  }
  if (lang === "php") {
    return (
      symName === "main" ||
      symName === "__invoke" ||
      /#\[Route\b/.test(attrsAndSig)
    );
  }
  if (lang === "ruby") {
    return symName === "main" || symName === "call";
  }
  if (lang === "python") {
    return (
      symName === "main" ||
      symName === "wsgi_app" ||
      symName === "asgi_app" ||
      symName === "__call__" ||
      /@[A-Za-z_][A-Za-z0-9_.]*\.(get|post|put|delete|route|websocket|command|group|action|on_\w+|before_request|after_request|teardown_request)/.test(
        attrsAndSig
      )
    );
  }
  if (lang === "go") {
    return (
      symName === "main" ||
      symName === "init" ||
      symName === "ServeHTTP" ||
      symName === "Run" ||
      /http\.ResponseWriter|gin\.Context|echo\.Context/.test(attrsAndSig)
    );
  }
  if (lang === "java" || lang === "kotlin") {
    return (
      symName === "main" ||
      /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping|Scheduled|EventListener|KafkaListener)/.test(
        attrsAndSig
      ) ||
      /^(onCreate|onStart|onResume|doFilter|service|doGet|doPost)$/.test(symName)
    );
  }
  if (lang === "cpp") {
    return /^(main|wmain|WinMain|wWinMain|DllMain)$/.test(symName);
  }
  return false;
}
