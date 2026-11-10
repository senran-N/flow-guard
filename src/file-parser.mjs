import fs from "node:fs";
import path from "node:path";
import {
  classifyZone,
  detectPairedKind,
  normalizeFinger,
  buildShingleSet
} from "./fingerprint.mjs";
import {
  EXT_LANG,
  extractParamNames,
  matchSymbolDeclaration,
  isRuntimeEntrySource
} from "./lang-presets.mjs";
import { scanTokensAndScopes, resolveSymbolBounds } from "./lexer.mjs";

function extractBaseTypes(lang, line) {
  const bases = new Set();
  if (lang === "python") {
    const m = line.match(/class\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]+)\)/);
    if (m) {
      for (const id of m[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        if (!/^(object|ABC|ABCMeta|Generic|Protocol|Enum|IntEnum|Exception|BaseException|dict|list|tuple|str|int)$/.test(id)) {
          bases.add(id);
        }
      }
    }
  } else if (lang === "ruby") {
    const m = line.match(/(?:class|module)\s+[A-Za-z0-9_:]+\s*<\s*([A-Z][A-Za-z0-9_:]*)/);
    if (m) {
      const base = m[1].split("::").pop();
      if (base && !/^(Object|BasicObject|StandardError|RuntimeError)$/.test(base)) bases.add(base);
    }
  } else if (lang === "ts" || lang === "vue" || lang === "java" || lang === "php") {
    const m = line.match(/\b(?:extends|implements)\s+([^{]+)/);
    if (m) {
      const stripped = m[1].replace(/<[^>]*>/g, " ");
      for (const id of stripped.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []) {
        if (!/^(extends|implements|Object|Error|Exception|Array|Map|Set)$/.test(id)) bases.add(id);
      }
    }
  } else if (lang === "csharp" || lang === "cpp" || lang === "kotlin" || lang === "swift") {
    const m = line.match(/:\s*([^{;]+)/);
    if (m) {
      const stripped = m[1].replace(/<[^>]*>/g, " ").replace(/\b(?:public|protected|private|virtual|where|AnyObject|Codable|Sendable|Equatable|Hashable|Error)\b/g, " ");
      for (const id of stripped.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []) {
        if (!/^(IDisposable|IAsyncDisposable|IEnumerable|IComparable|IEquatable|Object|Exception|Attribute)$/.test(id)) {
          bases.add(id);
        }
      }
    }
  }
  return Array.from(bases);
}

function findPythonBlockEnd(lines, startLineIdx, baseIndent) {
  let lastCodeLine = startLineIdx;
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    lastCodeLine = i;
  }
  return lastCodeLine;
}

function findRubyBlockEnd(lines, startLineIdx, baseIndent) {
  const firstTrimmed = (lines[startLineIdx] || "").trim();
  if (/;\s*end\s*$/.test(firstTrimmed)) return startLineIdx;

  let depth = 1;
  let lastCodeLine = startLineIdx;
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    lastCodeLine = i;
    const indent = raw.match(/^\s*/)[0].length;
    const opensBlock =
      /^(?:def|class|module|begin|case|if|unless|while|until|for)\b/.test(trimmed) ||
      /(?:=|\breturn)\s*(?:if|unless|case|begin)\b/.test(trimmed) ||
      /\bdo(?:\s*\|[^|]*\|)?\s*$/.test(trimmed);
    const closesInline = /;\s*end\s*$/.test(trimmed);
    if (opensBlock && !closesInline) depth++;
    if (/^end\b/.test(trimmed)) {
      depth--;
      if (depth <= 0 || indent <= baseIndent) return i;
    }
  }
  return lastCodeLine;
}

function isIntentionalStubBody(innerBody) {
  const stripped = innerBody
    .replace(/^[^{]*\{/, "")
    .replace(/\}\s*$/, "")
    .replace(/^\s*["'`]+\s*$/gm, "")
    .trim();
  if (!stripped) return true;
  if (
    /^(?:pass|\.\.\.|true|false|null|None|nil|0|self|this|return(?:\s+(?:None|null|nil|false|true|0|self|this|Ok\(\(\)\)|Collections\.empty[A-Za-z]+\(\)|Enumerable\.Empty<[^>]+>\(\)|nil\s*,\s*[A-Za-z0-9_.]+))?\s*;?)$/.test(
      stripped
    )
  ) {
    return true;
  }
  const flat = stripped.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  if (
    /^(?:raise\b|throw\s+new\b|unimplemented!\s*\(|todo!\s*\(|unreachable!\s*\(|panic!\s*\()[^;{}]*;?$/.test(
      flat
    )
  ) {
    return true;
  }
  // Virtual stub with a single precondition guard followed by `throw new ...`
  const stmts = flat.split(";").map((s) => s.trim()).filter(Boolean);
  if (stmts.length === 2 && /^(?:throw\s+new\b|raise\b)/.test(stmts[1])) {
    return true;
  }
  return false;
}

function extractDataFlowAndTouches({
  lang,
  decl,
  bounds,
  cleanCode,
  ownCleanLines,
  fullLexicalLines,
  params,
  bodyStartLineOffset,
  prevLines
}) {
  const sigHeader = ownCleanLines.slice(0, Math.max(1, bodyStartLineOffset)).join(" ");
  let innerLines = ownCleanLines.slice(Math.max(1, bodyStartLineOffset));
  let innerBody = innerLines.join("\n");
  let fullLexicalInnerBody = (fullLexicalLines || ownCleanLines).slice(Math.max(1, bodyStartLineOffset)).join("\n");

  if (bounds && bounds.isExpressionBody && bounds.exprStartOffset !== undefined) {
    let endOff = bounds.exprStartOffset;
    let linesLeft = Math.max(1, bounds.endLine - (bounds.paramSpan ? bounds.paramSpan.closeLine : 1) + 1);
    while (endOff < cleanCode.length && linesLeft > 0) {
      if (cleanCode[endOff] === "\n") linesLeft--;
      endOff++;
    }
    innerBody = cleanCode.slice(bounds.exprStartOffset, endOff);
    innerLines = innerBody.split(/\r?\n/);
    fullLexicalInnerBody = innerBody;
  }

  const fullBody = ownCleanLines.join("\n");
  const isFnOrMethod = decl.kind === "function" || decl.kind === "method";
  const hasRealBody =
    lang === "python" || lang === "ruby" || (bounds && (bounds.hasBraceBody || bounds.isExpressionBody));
  const isOverrideOrHook =
    Boolean(decl.isOverride) ||
    Boolean(decl.isContractMethod) ||
    /@(?:Override|SuppressWarnings|overload|t\.overload|typing\.overload|abstractmethod|abc\.abstractmethod|click\.)\b|\b(?:override|Deprecated)\b/.test(
      prevLines
    ) ||
    /\bclick\.(?:Context|Option|Parameter)\b/.test(sigHeader) ||
    /^__(?:exit|init_subclass|missing|get|set|delete|repr|str|format|getattr)__$/.test(decl.name);

  // 1. Check which input parameters are actually consumed in fullLexicalInnerBody (or C#/C++ `: base(...)` / `: member(...)` ctor initializer)
  const ctorInitSlice =
    (decl.isConstructor || lang === "cpp" || lang === "csharp") && bounds?.paramSpan
      ? cleanCode.slice(bounds.paramSpan.closeOffset + 1, bounds.braceSpan ? bounds.braceSpan.openOffset : bounds.paramSpan.closeOffset + 200)
      : "";
  const paramSearchText = ctorInitSlice ? `${ctorInitSlice}\n${fullLexicalInnerBody}` : fullLexicalInnerBody;
  const unusedParams = [];
  if (
    isFnOrMethod &&
    hasRealBody &&
    !bounds?.isTruncatedOrUncertain &&
    !isOverrideOrHook &&
    paramSearchText.trim().length > 0 &&
    !isIntentionalStubBody(fullLexicalInnerBody)
  ) {
    for (const p of params) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${esc}\\b`);
      if (!re.test(paramSearchText)) unusedParams.push(p);
    }
  }

  // 2. Check if function returns or yields a non-void value
  const isVoidMethod =
    ((lang === "csharp" || lang === "java" || lang === "cpp") && /\bvoid\b/.test(sigHeader)) ||
    (lang === "php" && /:\s*void\b/.test(sigHeader)) ||
    ((lang === "ts" || lang === "vue") && /:\s*(?:void\b|Promise\s*<\s*(?:void|undefined)\s*>)/.test(sigHeader));
  const isThrowExpression = /^\s*throw\b/.test(innerBody.trim());
  const hasExplicitReturn =
    !isVoidMethod &&
    (/\breturn[ \t]+[^\n;\s}#]+/.test(innerBody) ||
      (lang === "python" && /\byield\b/.test(innerBody)) ||
      (lang === "ruby" &&
        !decl.isConstructor &&
        innerBody.replace(/\bend\s*$/, "").trim().length > 0 &&
        !/^\s*(?:puts|print|p|pp|warn|raise)\b/.test(innerBody.trim())));
  const hasExprReturn =
    Boolean(bounds?.isExpressionBody) &&
    !isVoidMethod &&
    !isThrowExpression &&
    !/^(?:set[A-Z_][A-Za-z0-9_]*|[A-Za-z0-9_.]+\.(?:set|update|dispatch|emit|send|write|push|add|remove|delete|clear))\s*\(/.test(
      innerBody.trim()
    ) &&
    (lang === "ts" || lang === "vue" || lang === "python" || !/^[A-Za-z0-9_.]+\s*\([^)]*\)\s*;?$/.test(innerBody.trim()));
  const hasRustOrSwiftReturnType =
    (lang === "rust" || lang === "swift") && /->\s*(?!\(\s*\)|!|Void\b)[A-Za-z0-9_&*'\[\](<]/.test(sigHeader);
  const hasReturnValue =
    isFnOrMethod && (hasExplicitReturn || hasExprReturn || hasRustOrSwiftReturnType);

  const isPreconditionGuard =
    /\b(?:throw|raise|panic!)\b/.test(innerBody) &&
    (params.some((p) => {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\breturn\\s+${esc}\\s*;?`).test(innerBody);
    }) ||
      /^(?:against|check|ensure|require|validate|assert|verify)[A-Z_]/i.test(decl.name));

  const canIgnoreReturnValue =
    /@CanIgnoreReturnValue|#\[allow\(unused_must_use\)\]/.test(prevLines) ||
    /\breturn[ \t]+(?:this|self)\b/.test(innerBody) ||
    isPreconditionGuard;

  // 3. Bare statement calls (`foo(bar);`) and dead local variable assignments (`const x = foo(bar);`)
  const bareIgnoredCalls = [];
  const deadLocalVars = [];

  if (isFnOrMethod && hasRealBody && !bounds?.isExpressionBody) {
    let prevNonEmptyLine = "";
    for (let idx = Math.max(1, bodyStartLineOffset); idx < ownCleanLines.length; idx++) {
      const line = ownCleanLines[idx].trim();
      if (!line) continue;

      let nextNonEmptyLine = "";
      for (let nIdx = idx + 1; nIdx < ownCleanLines.length; nIdx++) {
        const cand = ownCleanLines[nIdx].trim();
        if (cand) {
          nextNonEmptyLine = cand;
          break;
        }
      }

      const isContinuation =
        /(?:[(,=+\-*/%?:&|^.\\]|->|=>|=\{|\breturn|\bthrow|\bawait)$/.test(prevNonEmptyLine) ||
        /^(?:[?.:&|+\-*/%]|==|!=|<=|>=|\bin\b|\binstanceof\b)/.test(nextNonEmptyLine);

      if (!isContinuation) {
        const bareM = line.match(
          /^(?:([A-Za-z_][A-Za-z0-9_]*)(?:\.|::))?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*(;)?$/
        );
        if (
          bareM &&
          (lang !== "rust" || Boolean(bareM[4])) &&
          !/^(if|for|foreach|while|switch|catch|return|throw|await|lock|using|super|base|this|assert|panic|unreachable|todo|unimplemented)$/.test(
            bareM[2]
          )
        ) {
          bareIgnoredCalls.push({
            qualifier: bareM[1] || null,
            callee: bareM[2],
            lineOffset: idx
          });
        }

        const localM = line.match(
          /^(?:(?:const\s+(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*(?:<[^>]+>)?(?:\s*[*&])?\s+|(?:const|let|var|auto)\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::(?!:)[^=]+)?=\s*|([a-zA-Z_][a-zA-Z0-9_]*)\s*:=\s*)(?:await\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\(/
        );
        if (localM) {
          const varName = localM[1] || localM[2];
          const callee = localM[3];
          if (
            varName &&
            !varName.startsWith("_") &&
            !/^(async|function|if|for|while|switch|return|new)$/.test(callee)
          ) {
            const lexLines = fullLexicalLines || ownCleanLines;
            const sameLineAfterSemi = line.includes(";") ? line.slice(line.indexOf(";") + 1) + "\n" : "";
            const restText = sameLineAfterSemi + lexLines.slice(idx + 1).join("\n");
            const beforeText = lexLines.slice(1, idx).join("\n");
            const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const varRe = new RegExp(`\\b${esc}\\b`);
            const earlierDeclRe = new RegExp(`\\b(?:const|let|var|auto)\\s+${esc}\\b|\\b${esc}\\s*:=`);
            const usedInClosureBefore = !earlierDeclRe.test(beforeText) && varRe.test(beforeText);
            if (!varRe.test(restText) && !usedInClosureBefore) {
              deadLocalVars.push({ varName, callee, lineOffset: idx });
            }
          }
        }
      }

      prevNonEmptyLine = line;
    }
  }

  // 4. Control-flow conditional branches count
  const branchMatches = fullBody.match(/\b(?:if|else\s+if|case|switch|match)\b/g);
  const conditionalCount = branchMatches ? branchMatches.length : 0;

  // 5. Qualified member calls (`obj.method(`, `a.b.method(`, `obj->method(`, or `Type::method(`)
  const qualifiedCalls = [];
  const qualCallRe =
    /(?:\b|\$)([A-Za-z_][A-Za-z0-9_]*)(?:(?:\.|->)([A-Za-z_][A-Za-z0-9_]*))*(?:\.|->|::)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = qualCallRe.exec(fullBody)) !== null) {
    qualifiedCalls.push({
      rootReceiver: m[1],
      receiver: m[2] || m[1],
      member: m[3],
      isLocal: false
    });
  }

  // 6. Internal state mutation detection (excluding purely local accumulators & loop counters)
  const localVars = new Set();
  const paramSet = new Set(params);
  const localDeclRe =
    /\b(?:const|let|var|auto|mut|val)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b|\b([A-Za-z_][A-Za-z0-9_]*)\s*:=/g;
  while ((m = localDeclRe.exec(innerBody)) !== null) {
    localVars.add(m[1] || m[2]);
  }
  const destructDeclRe = /\b(?:const|let|var)\s*(?:\{([^}]+)\}|\[([^\]]+)\])\s*=/g;
  while ((m = destructDeclRe.exec(innerBody)) !== null) {
    const rawNames = m[1] || m[2] || "";
    for (const tok of rawNames.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []) {
      localVars.add(tok);
    }
  }
  const typedLocalRe =
    /\b(?:int|long|short|byte|uint|ulong|size_t|ssize_t|float|double|bool|boolean|char|string|String)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[=;,)[]/g;
  while ((m = typedLocalRe.exec(innerBody)) !== null) {
    localVars.add(m[1]);
  }
  if (lang === "python" || lang === "ruby") {
    const pyLocalRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)|\bfor\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\b/gm;
    while ((m = pyLocalRe.exec(innerBody)) !== null) {
      const v = m[1] || m[2];
      if (v && v !== "self") localVars.add(v);
    }
  } else if (lang === "php") {
    const phpLocalRe = /\$([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g;
    while ((m = phpLocalRe.exec(innerBody)) !== null) {
      if (m[1] !== "this") localVars.add(m[1]);
    }
  }

  const isNonLocalTarget = (recv) => {
    if (!recv) return false;
    if (/^(?:this|self|state|store|\$this)(?:\.|->|$)/.test(recv) || recv.startsWith("_")) return true;
    return !localVars.has(recv) || paramSet.has(recv);
  };

  for (const qc of qualifiedCalls) {
    if (localVars.has(qc.rootReceiver) && !paramSet.has(qc.rootReceiver)) {
      qc.isLocal = true;
    }
  }

  let hasInternalMutation =
    /(?:<<<|\b(?:this|self|state|store)(?:\.|->)[A-Za-z_][A-Za-z0-9_]*\s*(?:=|\+=|-=|\*=|\+\+|--)|\$this->[A-Za-z_][A-Za-z0-9_]*\s*(?:=|\+=|-=|\*=|\+\+|--)|(?<!@)@[a-zA-Z_][a-zA-Z0-9_]*\s*(?:=|\+=|-=)(?!=)|\b_[a-zA-Z0-9_]+\s*(?:=|\+=|-=|\+\+|--)(?!=)|\*[a-zA-Z_][a-zA-Z0-9_]*\s*=(?!=)|(?:\.|->)(?:Write|WriteLine|Send|Emit|Flush|Close|Dispose|Save|Execute|Commit|Publish|Broadcast|Dispatch|write|send|emit|flush|close|dispose|save|commit|publish|broadcast|dispatch|postMessage|setItem|removeItem)(?:\s*<[^>]*>)?\s*\(|\b(?:swrMutate|mutate|revalidate\w*|invalidate\w*|on[A-Z]\w*|set[A-Z]\w*|handle[A-Z]\w*|clearTimeout|clearInterval|setTimeout|setInterval|appendFileSync|writeFileSync|execFileSync|execSync|spawnSync|mkdirSync|rmSync|unlinkSync|copyFileSync|GetProcAddress|LoadLibrary\w*|SetProcessInformation|SetProcessDpiAwarenessContext|SetThreadDescription|ShellExecute\w*|CreateProcess\w*)(?:\s*<[^>]*>)?\s*\()/.test(
      innerBody
    );

  if (!hasInternalMutation) {
    const collMutRe =
      /((?:(?:this|self)(?:\.|->)|\$this->)?[A-Za-z_$][A-Za-z0-9_$]*)(?:\.|->)(?:Add|Remove|Clear|Insert|Push|Pop|Set|Delete|Append|add|remove|clear|insert|push|pop|set|delete|append|splice|shift|unshift|sort|reverse)(?:\s*<[^>]*>)?\s*\(/g;
    while ((m = collMutRe.exec(innerBody)) !== null) {
      if (isNonLocalTarget(m[1])) {
        hasInternalMutation = true;
        break;
      }
    }
  }
  if (!hasInternalMutation) {
    const idxMutRe = /((?:(?:this|self)(?:\.|->)|\$this->)?[A-Za-z_$][A-Za-z0-9_$]*)\s*\[[^\]]+\]\s*(?:=|\+=|-=)(?!=)/g;
    while ((m = idxMutRe.exec(innerBody)) !== null) {
      if (isNonLocalTarget(m[1])) {
        hasInternalMutation = true;
        break;
      }
    }
  }
  if (!hasInternalMutation) {
    const incMutRe =
      /(?:((?:(?:this|self)(?:\.|->)|\$this->)?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\+\+|--)|(?:\+\+|--)\s*((?:(?:this|self)(?:\.|->)|\$this->)?[A-Za-z_$][A-Za-z0-9_$]*))/g;
    while ((m = incMutRe.exec(innerBody)) !== null) {
      if (isNonLocalTarget(m[1] || m[2])) {
        hasInternalMutation = true;
        break;
      }
    }
  }
  if (!hasInternalMutation) {
    const delMutRe = /\bdelete\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    while ((m = delMutRe.exec(innerBody)) !== null) {
      if (isNonLocalTarget(m[1])) {
        hasInternalMutation = true;
        break;
      }
    }
  }
  if (
    !hasInternalMutation &&
    lang !== "python" &&
    lang !== "ruby" &&
    lang !== "php"
  ) {
    const outerAssignRe = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|\+=|-=)(?![=>])[^,\n]*;\s*$/gm;
    while ((m = outerAssignRe.exec(innerBody)) !== null) {
      const lhs = m[1];
      if (!/^(?:return|case|default|throw)$/.test(lhs) && !localVars.has(lhs) && !paramSet.has(lhs)) {
        hasInternalMutation = true;
        break;
      }
    }
  }

  const writes = new Set();
  const reads = new Set();
  const returnsOrPassesLocalState = /\breturn\s+state\b|&\s*state\b/.test(fullBody);
  const DOM_CALLBACK_PROPS = /^(?:onmessage|onerror|onclose|onopen|onload|onabort|onupgradeneeded|onsuccess|onreadystatechange)$/;
  const writeRe =
    /(?:\b(this|self|state|store)|(\$this))(?:(?:\.|->)[a-zA-Z_][a-zA-Z0-9_]*)?(?:\.|->)([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|\+=|-=)(?!=)/g;
  while ((m = writeRe.exec(fullBody)) !== null) {
    const rootObj = m[1] || m[2];
    const field = m[3];
    const op = m[4];
    if (DOM_CALLBACK_PROPS.test(field)) continue;
    const afterAssign = fullBody.slice(m.index + m[0].length, m.index + m[0].length + 60);
    // Ignore constructor method-binding `this.fn = this.fn.bind(this)`
    if (new RegExp(`^\\s*(?:this|self)\\.${field}\\.bind\\s*\\(`).test(afterAssign)) {
      continue;
    }
    if (field.length > 1) writes.add(field);
    if ((op === "+=" || op === "-=" || (rootObj === "state" && returnsOrPassesLocalState)) && field.length > 1) {
      reads.add(field);
    }
  }

  // Strip only the LHS of pure `=` assignments so any other read of the same field in the same method is preserved
  const bodyWithoutWriteLhs = fullBody.replace(
    /(?:\b(this|self|state|store)|(\$this))(?:(?:\.|->)[a-zA-Z_][a-zA-Z0-9_]*)?(?:\.|->)([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g,
    " ="
  );
  const readRe =
    /(?:\b(this|self|state|store|ctx|[A-Z][A-Za-z0-9_]*)|(\$this))(?:(?:\.|->)[a-zA-Z_][a-zA-Z0-9_]*)?(?:\.|->)([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*\()/g;
  while ((m = readRe.exec(bodyWithoutWriteLhs)) !== null) {
    const field = m[3];
    if (field.length > 1) reads.add(field);
  }
  if (lang === "ruby") {
    const rbWriteRe = /(?<!@)@([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|\+=|-=)(?!=)/g;
    while ((m = rbWriteRe.exec(fullBody)) !== null) {
      if (m[1].length > 1) writes.add(m[1]);
      if (m[2] !== "=" && m[1].length > 1) reads.add(m[1]);
    }
    const rbWithoutWrite = fullBody.replace(/(?<!@)@([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g, " =");
    const rbReadRe = /(?<!@)@([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    while ((m = rbReadRe.exec(rbWithoutWrite)) !== null) {
      if (m[1].length > 1) reads.add(m[1]);
    }
  }

  return {
    unusedParams,
    hasReturnValue,
    canIgnoreReturnValue,
    hasInternalMutation,
    bareIgnoredCalls,
    deadLocalVars,
    conditionalCount,
    qualifiedCalls,
    writes: Array.from(writes),
    reads: Array.from(reads)
  };
}

function extractFileImports(lang, content) {
  const importedStems = new Set();
  const importedPaths = [];
  let m;
  if (lang === "ts" || lang === "vue") {
    const re = /\bfrom\s+["']([^"']+)["']/g;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      const base = path.basename(m[1], path.extname(m[1]));
      if (base) importedStems.add(base);
    }
  } else if (lang === "rust") {
    const re = /\b(?:mod|use\s+(?:crate|super)::(?:[a-zA-Z0-9_]+::)*)([a-zA-Z0-9_]+)/g;
    while ((m = re.exec(content)) !== null) importedStems.add(m[1]);
  } else if (lang === "python") {
    const re = /\b(?:from|import)\s+\.*([a-zA-Z0-9_.]+)/g;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      const parts = m[1].split(".");
      if (parts[parts.length - 1]) importedStems.add(parts[parts.length - 1]);
    }
  } else if (lang === "cpp") {
    const re = /^\s*#\s*include\s*["<]([^">]+)[">]/gm;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      const base = path.basename(m[1], path.extname(m[1]));
      if (base) importedStems.add(base);
    }
  } else if (lang === "php") {
    const re = /\buse\s+(?:[A-Za-z0-9_]+\\)+([A-Za-z0-9_]+)|(?:require|include)(?:_once)?\s*\(?["']([^"']+)["']/g;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) importedStems.add(m[1]);
      if (m[2]) {
        importedPaths.push(m[2]);
        const base = path.basename(m[2], path.extname(m[2]));
        if (base) importedStems.add(base);
      }
    }
  } else if (lang === "ruby") {
    const re = /\brequire(?:_relative)?\s*\(?["']([^"']+)["']/g;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      const base = path.basename(m[1], path.extname(m[1]));
      if (base) importedStems.add(base);
    }
  }
  return {
    importedStems: Array.from(importedStems),
    importedPaths
  };
}

export function parseSourceFile(absPath, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang || !fs.existsSync(absPath)) return null;

  const content = fs.readFileSync(absPath, "utf8");
  const rawLines = content.split(/\r?\n/);
  const { cleanCode, commentlessCode, lineStartOffsets, parenSpans, braceSpans } = scanTokensAndScopes(content, lang);
  const cleanLines = cleanCode.split(/\r?\n/);

  const fileZone = classifyZone(relPath);
  const { importedStems, importedPaths } = extractFileImports(lang, content);
  const fileHasUnityOrHarmony =
    lang === "csharp" && /\b(?:UnityEngine|MonoBehaviour|BaseUnityPlugin|HarmonyLib|HarmonyPatch)\b/.test(content);

  // Detect Rust inline `#[cfg(test)]` block ranges so inline unit test modules are marked as `test` zone
  const inlineTestRanges = [];
  if (lang === "rust") {
    for (let i = 0; i < rawLines.length; i++) {
      if (/#\s*\[\s*cfg\s*\(\s*test\b/.test(rawLines[i])) {
        const line1 = i + 1;
        for (const bs of braceSpans) {
          if (bs.openLine >= line1 && bs.openLine <= line1 + 6) {
            inlineTestRanges.push({ startLine: line1, endLine: bs.closeLine });
            break;
          }
        }
      }
    }
  }

  const rawDecls = [];
  const containerRanges = []; // { name, startLine, endLine, symbolId, kind }

  // Pass 1: Identify all symbol declarations and their exact line spans
  for (let i = 0; i < cleanLines.length; i++) {
    const currentLine = i + 1;
    const prevRaw = i > 0 ? rawLines.slice(Math.max(0, i - 2), i).join("\n") : "";
    if (lang === "python" && /@(?:t\.|typing\.)?overload\b/.test(prevRaw)) {
      continue;
    }

    // Only treat `inClassScope` as true when the innermost enclosing `{...}` block on this line is a class/struct/impl container
    const enclosingClass = containerRanges
      .filter((c) => (c.kind === "class" || c.kind === "struct" || c.kind === "impl") && currentLine > c.startLine && currentLine < c.endLine)
      .pop();
    let inClassScope = false;
    if (enclosingClass) {
      const deeperBrace = braceSpans.some(
        (bs) =>
          bs.openLine > enclosingClass.startLine &&
          bs.openLine < currentLine &&
          bs.closeLine >= currentLine
      );
      inClassScope = !deeperBrace;
    }

    const declLineText =
      (lang === "ts" || lang === "vue") && /=\s*(?:async\s*)?(?:<[^>]*>\s*)?\([^;]*$/.test(cleanLines[i])
        ? cleanLines.slice(i, Math.min(cleanLines.length, i + 8)).join(" ")
        : cleanLines[i];
    const decl = matchSymbolDeclaration(lang, declLineText, inClassScope);
    if (!decl) continue;

    const startLine = currentLine;
    let endLine = startLine;
    let paramText = cleanLines[i];
    let bodyStartLineOffset = 1;
    let bounds = null;

    if (lang === "python" || lang === "ruby") {
      bounds = resolveSymbolBounds(cleanCode, cleanLines, lineStartOffsets, i, decl, lang, parenSpans, braceSpans);
      let sigEndLineIdx = i;
      if (bounds.paramSpan) {
        paramText = cleanCode.slice(bounds.paramSpan.openOffset, bounds.paramSpan.closeOffset + 1).replace(/\s+/g, " ");
        sigEndLineIdx = bounds.paramSpan.closeLine - 1;
        bodyStartLineOffset = Math.max(1, bounds.paramSpan.closeLine - startLine + 1);
      }
      endLine =
        (lang === "ruby"
          ? findRubyBlockEnd(cleanLines, sigEndLineIdx, decl.indent || 0)
          : findPythonBlockEnd(cleanLines, sigEndLineIdx, decl.indent || 0)) + 1;
    } else {
      bounds = resolveSymbolBounds(cleanCode, cleanLines, lineStartOffsets, i, decl, lang, parenSpans, braceSpans);
      endLine = bounds.endLine;
      if (bounds.paramSpan) {
        paramText = cleanCode.slice(bounds.paramSpan.openOffset, bounds.paramSpan.closeOffset + 1).replace(/\s+/g, " ");
        bodyStartLineOffset = Math.max(1, bounds.paramSpan.closeLine - startLine + 1);
      }
    }

    // Rust `impl Type { ... }` registers a container range linking methods to `Type`, without creating a duplicate symbol
    if (decl.kind === "impl") {
      const existingStruct = containerRanges.find((c) => c.name === decl.name && c.symbolId);
      containerRanges.push({
        name: decl.name,
        startLine,
        endLine,
        symbolId: existingStruct ? existingStruct.symbolId : null,
        kind: "impl",
        isTraitImpl: Boolean(decl.isTraitImpl)
      });
      continue;
    }

    let parentContainer = null;
    for (let cIdx = containerRanges.length - 1; cIdx >= 0; cIdx--) {
      const c = containerRanges[cIdx];
      if (startLine > c.startLine && endLine <= c.endLine) {
        parentContainer = c;
        break;
      }
    }

    if (
      parentContainer?.isTraitImpl ||
      parentContainer?.isTrait ||
      parentContainer?.isInterface ||
      (lang === "python" && /^__.*__$/.test(decl.name))
    ) {
      decl.isContractMethod = true;
      decl.isPublicApi = true;
    }
    if ((lang === "csharp" || lang === "java") && parentContainer?.hasBaseOrInterface) {
      decl.isContractMethod = true;
    }

    const containerName = parentContainer ? parentContainer.name : decl.receiverType || null;
    const symId = containerName
      ? `${relPath}::${containerName}.${decl.name}#L${startLine}`
      : `${relPath}::${decl.name}#L${startLine}`;

    if (decl.kind === "class" || decl.kind === "struct") {
      const baseTypes = extractBaseTypes(lang, cleanLines[i]);
      const hasBaseOrInterface =
        baseTypes.length > 0 ||
        (lang === "csharp" && /:\s*[A-Za-z_]/.test(cleanLines[i])) ||
        (lang === "java" && /\b(?:extends|implements)\b/.test(cleanLines[i]));
      decl.baseTypes = baseTypes;
      containerRanges.push({
        name: decl.name,
        startLine,
        endLine,
        symbolId: symId,
        kind: decl.kind,
        isTrait: Boolean(decl.isTrait),
        isInterface: Boolean(decl.isInterface),
        baseTypes,
        hasBaseOrInterface
      });
    }

    rawDecls.push({
      decl,
      lineIdx: i,
      startLine,
      endLine,
      bounds,
      paramText,
      bodyStartLineOffset,
      containerName,
      parentContainerId: parentContainer ? parentContainer.symbolId : null,
      symId
    });
  }

  // Backfill `parentContainerId` for Go receiver methods or Rust `impl` methods whose `struct` appeared in the same file
  const structIdByName = new Map();
  for (const rd of rawDecls) {
    if (rd.decl.kind === "class" || rd.decl.kind === "struct") {
      structIdByName.set(rd.decl.name, rd.symId);
    }
  }
  for (const rd of rawDecls) {
    if (!rd.parentContainerId && rd.containerName && structIdByName.has(rd.containerName)) {
      rd.parentContainerId = structIdByName.get(rd.containerName);
    }
  }

  const symbols = [];
  const fileCalls = new Set();

  // Pass 2: Extract data-flow and call touches per symbol (blanking out nested child symbol lines to prevent overlap)
  for (let idx = 0; idx < rawDecls.length; idx++) {
    const rd = rawDecls[idx];
    const { decl, lineIdx: i, startLine, endLine, bounds, paramText, bodyStartLineOffset, containerName, parentContainerId, symId } = rd;

    const fullLexicalLines = cleanLines.slice(i, endLine);
    const ownCleanLines = fullLexicalLines.slice();
    for (let otherIdx = 0; otherIdx < rawDecls.length; otherIdx++) {
      if (otherIdx === idx) continue;
      const child = rawDecls[otherIdx];
      if (child.startLine > startLine && child.endLine <= endLine) {
        for (let ln = child.startLine; ln <= child.endLine; ln++) {
          const relIdx = ln - startLine;
          if (relIdx >= 0 && relIdx < ownCleanLines.length) {
            ownCleanLines[relIdx] = "";
          }
        }
      }
    }

    const prevLines = rawLines.slice(Math.max(0, i - 6), i + 1).join("\n");
    const ownCleanBodyText = ownCleanLines.join("\n");

    let symZone = fileZone;
    if (
      symZone === "prod" &&
      lang === "rust" &&
      (inlineTestRanges.some((r) => startLine >= r.startLine && endLine <= r.endLine) ||
        /#\s*\[\s*(?:tokio::)?test\b|#\s*\[\s*cfg\s*\(\s*test\b/.test(prevLines))
    ) {
      symZone = "test";
    }

    const params = decl.kind === "function" || decl.kind === "method" ? extractParamNames(lang, paramText) : [];
    const df = extractDataFlowAndTouches({
      lang,
      decl,
      bounds,
      cleanCode,
      ownCleanLines,
      fullLexicalLines,
      params,
      bodyStartLineOffset,
      prevLines
    });

    const isEntrySource = isRuntimeEntrySource(
      lang,
      relPath,
      decl.name,
      prevLines,
      ownCleanBodyText,
      fileHasUnityOrHarmony
    );

    const calls = new Set();
    const callRe = /(#?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:(?:::)?<[^;{}()=]+>\s*|<<<[^;{}]+>>>\s*)?\(/g;
    let m;
    while ((m = callRe.exec(ownCleanBodyText)) !== null) {
      const callee = m[1];
      if (
        callee !== decl.name &&
        callee.length >= 1 &&
        !/^(if|for|foreach|while|switch|catch|return|new|typeof|sizeof|nameof|await|lock|using|Some|None|Ok|Err|vec|format|println|eprintln)$/.test(
          callee
        )
      ) {
        calls.add(callee);
        fileCalls.add(callee);
      }
    }

    for (const qc of df.qualifiedCalls) {
      if (!/^(this|self|super|base)$/.test(qc.receiver)) {
        calls.add(qc.receiver);
        calls.add(qc.member);
        fileCalls.add(qc.receiver);
        fileCalls.add(qc.member);
      }
    }

    if (lang === "csharp" || lang === "java") {
      const typeofRe = /\btypeof\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
      while ((m = typeofRe.exec(ownCleanBodyText)) !== null) {
        calls.add(m[1]);
        fileCalls.add(m[1]);
      }
      const attrRe = /\[\s*([A-Z][A-Za-z0-9_]*)\b/g;
      while ((m = attrRe.exec(prevLines)) !== null) {
        calls.add(m[1]);
        calls.add(`${m[1]}Attribute`);
        fileCalls.add(m[1]);
        fileCalls.add(`${m[1]}Attribute`);
      }
    }

    const rawDocAndHeader = rawLines
      .slice(Math.max(0, i - 4), Math.min(rawLines.length, i + 16))
      .join("\n");
    const isFeatureGated =
      /#\s*\[\s*(?:cfg|allow\s*\(\s*dead_code)\b|^\s*#\s*if\b|\bpragma:\s*no\s*cover\b|\/\/\s*reserved\b/im.test(
        rawDocAndHeader
      );
    const isExtensionHook =
      Boolean(decl.isContractMethod) ||
      Boolean(decl.isOverride) ||
      (containerName && /(?:Interface|Base|Scaffold|Adapter|Hook|Handler|Visitor|Listener|Strategy|Policy|Provider|Transport|Loader)$/.test(containerName)) ||
      /\b(?:subclasses?\s+(?:can|may|should)|can\s+be\s+overridden|override\s+this|default\s+implementation|extension\s+point|hook\s+for|intended\s+to\s+be\s+overridden|by\s+default\s+this)\b/i.test(
        rawDocAndHeader
      );

    const normFinger = decl.kind === "function" || decl.kind === "method" ? normalizeFinger(ownCleanBodyText) : "";
    symbols.push({
      id: symId,
      name: decl.name,
      parentContainerName: containerName,
      parentContainerId,
      baseTypes: decl.baseTypes || [],
      kind: decl.kind,
      isPublicApi: Boolean(decl.isPublicApi),
      isExtensionHook,
      isFeatureGated,
      file: relPath,
      lang,
      zone: symZone,
      startLine,
      endLine,
      isEntrySource,
      roles: isEntrySource ? ["source"] : [],
      isTauriCommand: lang === "rust" && /#\[(?:tauri::)?command\s*\]|#\[specta::specta\b/.test(prevLines),
      paired: detectPairedKind(decl.name),
      params,
      unusedParams: df.unusedParams,
      reservedParams: [],
      hasReturnValue: df.hasReturnValue,
      canIgnoreReturnValue: df.canIgnoreReturnValue,
      hasInternalMutation: df.hasInternalMutation,
      bareIgnoredCalls: df.bareIgnoredCalls,
      deadLocalVars: df.deadLocalVars,
      conditionalCount: df.conditionalCount,
      qualifiedCalls: df.qualifiedCalls,
      calls: Array.from(calls),
      writes: df.writes,
      reads: df.reads,
      ownCleanBodyText,
      snippet: rawLines.slice(Math.max(0, i - 1), Math.min(rawLines.length, i + 14)).join("\n"),
      shingles: buildShingleSet(normFinger)
    });
  }

  // Reconcile member field reads across the same file (`this.field = x` in constructor/setter, bare `field` or `obj.field` read in methods)
  const fileWrittenFields = new Set();
  for (const s of symbols) {
    for (const w of s.writes) fileWrittenFields.add(w);
  }
  if (fileWrittenFields.size > 0) {
    for (const field of fileWrittenFields) {
      const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const anyReadRe = new RegExp(`\\b${esc}\\b(?!\\s*=(?!=))`);
      let matchedInSymbol = false;
      for (const s of symbols) {
        if (s.reads.includes(field)) {
          matchedInSymbol = true;
          continue;
        }
        if (anyReadRe.test(s.ownCleanBodyText || "")) {
          const withoutWriteLhs = (s.ownCleanBodyText || "").replace(
            new RegExp(`\\b(?:this|self|state|store)(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)?\\.${esc}\\s*=(?!=)(?:\\s*${esc}\\b)?`, "g"),
            ""
          );
          if (anyReadRe.test(withoutWriteLhs)) {
            s.reads.push(field);
            matchedInSymbol = true;
          }
        }
      }
      if (!matchedInSymbol && symbols.length > 0) {
        const fileWithoutWriteLhs = cleanCode.replace(
          new RegExp(`\\b(?:this|self|state|store)(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)?\\.${esc}\\s*=(?!=)(?:\\s*${esc}\\b)?`, "g"),
          ""
        );
        if (anyReadRe.test(fileWithoutWriteLhs)) {
          const hostSym = symbols.find((s) => s.isEntrySource) || symbols[0];
          if (!hostSym.reads.includes(field)) hostSym.reads.push(field);
        }
      }
    }
  }
  for (const s of symbols) delete s.ownCleanBodyText;

  // Detect bottom-of-file exports (`export { foo, bar }`, `export default foo`) and same-file callback/table wiring
  if (lang === "ts" || lang === "vue") {
    const expBlockRe = /\bexport\s*(?:type\s*)?\{([^}]+)\}|\bexport\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let em;
    const exportedNames = new Set();
    while ((em = expBlockRe.exec(cleanCode)) !== null) {
      if (em[1]) {
        for (const part of em[1].split(",")) {
          const tokens = part.trim().split(/\s+as\s+/);
          if (tokens[0]) exportedNames.add(tokens[0].trim());
          if (tokens[1]) exportedNames.add(tokens[1].trim());
        }
      } else if (em[2]) {
        exportedNames.add(em[2].trim());
      }
    }
    for (const s of symbols) {
      if (exportedNames.has(s.name)) s.isPublicApi = true;
    }
  }

  // Same-file first-class callback / table registration / Vue template / Rust serde / C# reflection binding detection
  const hasReflectedDeclaredMethods =
    lang === "csharp" && /\b(?:DeclaredMethods|GetMethods)\b/.test(cleanCode);
  const rawOutsideLines = rawLines;
  for (const s of symbols) {
    if (s.kind !== "function" && s.kind !== "method") continue;
    if (hasReflectedDeclaredMethods && s.parentContainerName && cleanCode.includes(`typeof(${s.parentContainerName})`)) {
      s.isReferencedInFile = true;
      continue;
    }
    const esc = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const refRe = new RegExp(`\\b${esc}\\b`);
    const useRawLines = lang === "vue" || lang === "rust";
    const beforeSym = (useRawLines ? rawOutsideLines : cleanLines).slice(0, s.startLine - 1).join("\n");
    const afterSym = (useRawLines ? rawOutsideLines : cleanLines).slice(s.endLine).join("\n");
    if (refRe.test(beforeSym) || refRe.test(afterSym)) {
      s.isReferencedInFile = true;
      for (const other of symbols) {
        if (other.id !== s.id && (s.startLine < other.startLine || s.endLine > other.endLine)) {
          const otherSlice = cleanLines.slice(other.startLine - 1, other.endLine).join("\n");
          if (refRe.test(otherSlice) && !other.calls.includes(s.name)) {
            other.calls.push(s.name);
          }
        }
      }
    }
  }

  // Top-level runtime bootstrap detection (shebang CLI, process.stdin/argv, Python `__main__`, server listeners)
  if (symbols.length > 0) {
    const coveredBySymbol = new Uint8Array(cleanLines.length);
    for (const s of symbols) {
      for (let ln = s.startLine - 1; ln < Math.min(cleanLines.length, s.endLine); ln++) {
        if (ln >= 0) coveredBySymbol[ln] = 1;
      }
    }
    const topLevelLines = [];
    for (let ln = 0; ln < cleanLines.length; ln++) {
      if (!coveredBySymbol[ln]) topLevelLines.push(cleanLines[ln]);
    }
    const topLevelText = topLevelLines.join("\n");
    const hasBootstrapTrigger =
      (rawLines[0] || "").startsWith("#!") ||
      /\b(?:process\.(?:argv|stdin)|Deno\.args|Bun\.serve|createServer|ipcMain\.(?:handle|on)|addEventListener\s*\()/.test(
        topLevelText
      ) ||
      /__name__\s*==\s*["']__main__["']/.test(
        rawLines.filter((_, idx) => !coveredBySymbol[idx]).join("\n")
      );
    if (hasBootstrapTrigger) {
      for (const s of symbols) {
        if (s.kind !== "function" && s.kind !== "method") continue;
        const esc = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${esc}\\s*\\(`).test(topLevelText)) {
          s.isEntrySource = true;
          if (!s.roles.includes("source")) s.roles.push("source");
        }
      }
    }
  }

  // Cross-boundary signals (with 1-based line numbers for exact symbol-level attribution)
  const bridgeSignals = {
    tauriInvokes: [],
    rpcCalls: [],
    eventTouches: [],
    electronSends: [],
    electronHandles: [],
    httpCalls: [],
    httpRoutes: [],
    configTouches: []
  };
  const commentStripped = commentlessCode;
  const offsetToLine = (offset) => {
    let lo = 0;
    let hi = lineStartOffsets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStartOffsets[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(1, hi + 1);
  };
  const seenSig = new Set();
  const addUnique = (arr, key, item) => {
    if (!seenSig.has(key)) {
      seenSig.add(key);
      arr.push(item);
    }
  };

  let m;
  const cfgRe = /["']([a-zA-Z0-9_-]+\.(?:json|toml|yaml|ini|cfg))["']/g;
  while ((m = cfgRe.exec(commentStripped)) !== null) {
    const cfgName = m[1];
    if (!/^(package|tsconfig|tauri\.conf|Cargo|plugin|hooks|mcp_config)\.json$/i.test(cfgName)) {
      const ctx = commentStripped.slice(Math.max(0, m.index - 120), Math.min(commentStripped.length, m.index + 120));
      const mode = /write|save|create|serialize|to_string/i.test(ctx) ? "write" : "read";
      addUnique(bridgeSignals.configTouches, `CFG:${cfgName}:${mode}`, {
        file: cfgName,
        mode,
        line: offsetToLine(m.index)
      });
    }
  }

  const envRe = /\bL?["']([A-Z][A-Z0-9]{1,}_[A-Z0-9_]+)["']|["']([A-Z][A-Z0-9]{1,}_[A-Z0-9_]+)["']/g;
  while ((m = envRe.exec(commentStripped)) !== null) {
    const envName = m[1] || m[2];
    const ctx = commentStripped.slice(Math.max(0, m.index - 120), Math.min(commentStripped.length, m.index + 120));
    const isPairEntry = /\{\s*L?["'][A-Z][A-Z0-9]{1,}_[A-Z0-9_]+["']\s*,/.test(ctx);
    if (isPairEntry || /env|Environment|GetEnvironmentVariable|set_var|getenv|putenv/i.test(ctx)) {
      const mode = isPairEntry || /\.env\s*\(|set_var|SetEnvironmentVariable|BuildEnvironment|putenv/i.test(ctx) ? "write" : "read";
      addUnique(bridgeSignals.configTouches, `ENV:${envName}:${mode}`, {
        file: `ENV:${envName}`,
        mode,
        line: offsetToLine(m.index)
      });
    }
  }

  // Custom URI Event Topics (`"verge://refresh-verge-config"`, `"app://..."`), WebView/JSON Command Dispatch (`send("cmd")` <-> `cmd == "cmd"`)
  const uriEventRe = /["']([a-z][a-z0-9_-]{1,15}:\/\/[a-z][a-z0-9_/-]+)["']/g;
  while ((m = uriEventRe.exec(commentStripped)) !== null) {
    const topic = m[1];
    if (!/^(?:https?|wss?|ftp|file|mailto|data|chrome|about|edge|vscode):\/\//i.test(topic)) {
      const isFrontend = lang === "ts" || lang === "vue";
      const mode = isFrontend ? "listen" : "emit";
      addUnique(bridgeSignals.eventTouches, `EVT:${topic}:${mode}`, {
        topic,
        mode,
        line: offsetToLine(m.index)
      });
    }
  }

  const msgEmitRe = /\bsend\s*\(\s*["']([a-zA-Z][a-zA-Z0-9_.-]{2,})["']|["'](?:cmd|method)["']\s*[,:]\s*["']([a-zA-Z][a-zA-Z0-9_.-]{2,})["']/g;
  while ((m = msgEmitRe.exec(commentStripped)) !== null) {
    const cmdTopic = `cmd:${m[1] || m[2]}`;
    addUnique(bridgeSignals.eventTouches, `EVT:${cmdTopic}:emit`, {
      topic: cmdTopic,
      mode: "emit",
      line: offsetToLine(m.index)
    });
  }
  const msgListenRe = /\b(?:cmd|method)\s*==\s*["']([a-zA-Z][a-zA-Z0-9_.-]{2,})["']/g;
  while ((m = msgListenRe.exec(commentStripped)) !== null) {
    const cmdTopic = `cmd:${m[1]}`;
    addUnique(bridgeSignals.eventTouches, `EVT:${cmdTopic}:listen`, {
      topic: cmdTopic,
      mode: "listen",
      line: offsetToLine(m.index)
    });
  }

  if (lang === "ts" || lang === "vue") {
    if (!/\b(?:function\s+invoke|(?:const|let|var)\s+invoke\s*=)\b/.test(cleanCode)) {
      const invRe = /\b(?:__TAURI_INVOKE|TAURI_INVOKE|invoke)\s*(?:<[^>]*>)?\s*\(\s*["']([a-z_][a-z0-9_]+)["']/g;
      while ((m = invRe.exec(commentStripped)) !== null) {
        addUnique(bridgeSignals.tauriInvokes, `TAURI:${m[1]}`, { cmd: m[1], line: offsetToLine(m.index) });
      }
    }
    const rpcRe = /\b([a-zA-Z0-9_$]+(?:ServiceClient|AuthClient|RpcClient))\.([a-z][a-zA-Z0-9_]*)\s*\(/g;
    while ((m = rpcRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.rpcCalls, `RPC:${m[1]}.${m[2]}`, {
        client: m[1],
        method: m[2],
        line: offsetToLine(m.index)
      });
    }
    const elSendRe = /\bipcRenderer\.(?:invoke|send)\s*\(\s*["']([^"']+)["']/g;
    while ((m = elSendRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.electronSends, `ELSEND:${m[1]}`, { channel: m[1], line: offsetToLine(m.index) });
    }
    const elHandleRe = /\bipcMain\.(?:handle|on)\s*\(\s*["']([^"']+)["']/g;
    while ((m = elHandleRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.electronHandles, `ELHND:${m[1]}`, { channel: m[1], line: offsetToLine(m.index) });
    }
    const httpRe = /\b(?:fetch|axios\.(?:get|post|put|delete|patch))\s*\(\s*["'`](\/api\/[^"'`?\s]+)/g;
    while ((m = httpRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.httpCalls, `HTTPCALL:${m[1]}`, { path: m[1], line: offsetToLine(m.index) });
    }
  }

  const routeRe =
    /(?:#\[(?:get|post|put|delete|patch|Route)|@(?:app|router|bp|GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)(?:\.(?:get|post|put|delete|patch|route))?|\[Http(?:Get|Post|Put|Delete|Patch)|\bRoute::(?:get|post|put|delete|patch)|\b(?:app|router|mux|r|e)\.(?:get|post|put|delete|patch|GET|POST|PUT|DELETE|PATCH|HandleFunc))\s*\(\s*["'](\/[^"']+)["']/g;
  while ((m = routeRe.exec(commentStripped)) !== null) {
    addUnique(bridgeSignals.httpRoutes, `HTTPROUTE:${m[1]}`, { path: m[1], line: offsetToLine(m.index) });
  }

  if (symbols.length === 0) {
    const baseName = path.basename(relPath, ext);
    const df = extractDataFlowAndTouches({
      lang,
      decl: { name: baseName, kind: "module" },
      bounds: null,
      cleanCode,
      ownCleanLines: cleanLines,
      params: [],
      bodyStartLineOffset: 1,
      prevLines: content.slice(0, 300)
    });
    const isEntrySource = isRuntimeEntrySource(
      lang,
      relPath,
      baseName,
      content.slice(0, 300),
      cleanCode,
      fileHasUnityOrHarmony
    );
    const calls = new Set();
    const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    while ((m = callRe.exec(cleanCode)) !== null) {
      if (m[1].length >= 2) calls.add(m[1]);
    }
    symbols.push({
      id: `${relPath}::${baseName}#L1`,
      name: baseName,
      parentContainerName: null,
      parentContainerId: null,
      kind: "module",
      isPublicApi: true,
      file: relPath,
      lang,
      zone: fileZone,
      startLine: 1,
      endLine: rawLines.length,
      isEntrySource,
      roles: isEntrySource ? ["source"] : [],
      isTauriCommand: false,
      paired: null,
      params: [],
      unusedParams: [],
      hasReturnValue: false,
      canIgnoreReturnValue: false,
      hasInternalMutation: df.hasInternalMutation,
      bareIgnoredCalls: [],
      deadLocalVars: [],
      conditionalCount: df.conditionalCount,
      qualifiedCalls: df.qualifiedCalls,
      calls: Array.from(calls),
      writes: df.writes,
      reads: df.reads,
      snippet: rawLines.slice(0, 15).join("\n"),
      shingles: new Set()
    });
  }

  return {
    file: relPath,
    lang,
    zone: fileZone,
    importedStems,
    importedPaths,
    symbols,
    fileCalls: Array.from(fileCalls),
    bridgeSignals
  };
}
