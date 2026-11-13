import crypto from "node:crypto";
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
  extractPromotedParamNames,
  extractRefOutParamNames,
  matchSymbolDeclaration,
  isRuntimeEntrySource
} from "./lang-presets.mjs";
import { scanTokensAndScopes, resolveSymbolBounds } from "./lexer.mjs";
import { conditionalContexts } from "./conditional-context.mjs";
import { parseRustImports, rustAttributesBefore, rustAttributeBodies } from "./rust-imports.mjs";
import { rustAttributesZone } from "./rust-zones.mjs";
import { parseRustReceiverFacts } from "./rust-receivers.mjs";
import { parsePythonDependencies } from "./python-dependencies.mjs";
import { parseFrameworkCallbackFacts } from "./framework-callbacks.mjs";
import { parseRustTypeFlow } from './rust-type-flow.mjs';
import { parseRustMacroTypes } from './rust-macro-types.mjs';

function makeIdentRegex(ident, flags = "", lang = "") {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowLeadingDollarSigil =
    (lang === "php" || lang === "kotlin" || lang === "dart") && !ident.startsWith("$") && !ident.startsWith("#");
  const left = ident.startsWith("#")
    ? "(?<![A-Za-z0-9_#])"
    : allowLeadingDollarSigil
      ? "(?<![A-Za-z0-9_])"
      : "(?<![A-Za-z0-9_$])";
  const right = "(?![A-Za-z0-9_$])";
  return new RegExp(`${left}${esc}${right}`, flags);
}

function stripNestedClosureBodies(code) {
  if (!code || (!code.includes("=>") && !code.includes("function"))) return code;
  const chars = code.split("");
  const closureHeadRe = /(?:=>|\bfunction(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\([^;{}]*\))\s*\{/g;
  let m;
  while ((m = closureHeadRe.exec(code)) !== null) {
    const openIdx = m.index + m[0].lastIndexOf("{");
    let depth = 1;
    let k = openIdx + 1;
    while (k < chars.length && depth > 0) {
      if (code[k] === "{") depth++;
      else if (code[k] === "}") depth--;
      if (depth > 0 && chars[k] !== "\n" && chars[k] !== "\r") {
        chars[k] = " ";
      }
      k++;
    }
  }
  return chars.join("");
}

function extractBaseTypes(lang, line) {
  const omitBalanced = (text, open, close) => {
    let depth = 0, out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === open) { depth++; continue; }
      if (ch === close && depth > 0 && !(close === ">" && /[-=]/.test(text[i - 1] || ""))) { depth--; continue; }
      if (depth === 0) out += ch;
    }
    return out;
  };
  // Generic parameter constraints are not inheritance clauses; keep qualified
  // type names intact instead of treating their module and type as two bases.
  const header = omitBalanced(line, "<", ">").split(/\bwhere\b/)[0];
  const bases = new Set();
  const add = (value) => {
    const cleaned = value.replace(/\b(?:public|protected|private|virtual)\s+/g, "").replace(/@\w+\s+/g, "").trim();
    const name = cleaned.match(/^\\?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|[.\\])[A-Za-z_$][A-Za-z0-9_$]*)*/)?.[0];
    if (name && !/^(?:object|ABC|ABCMeta|Generic|Protocol|Enum|IntEnum|Exception|BaseException|dict|list|tuple|str|int|Object|BasicObject|StandardError|RuntimeError|Error|Array|Map|Set|AnyObject|Codable|Sendable|Equatable|Hashable|IDisposable|IAsyncDisposable|IEnumerable|IComparable|IEquatable|Attribute)$/.test(name)) bases.add(name);
  };
  if (lang === "python") {
    const m = omitBalanced(header, "[", "]").match(/class\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]+)\)/);
    if (m) {
      for (const base of m[1].split(",")) if (!base.includes("=")) add(base);
    }
  } else if (lang === "ruby") {
    const m = line.match(/(?:class|module)\s+[A-Za-z0-9_:]+\s*<\s*([A-Z][A-Za-z0-9_:]*)/);
    if (m) add(m[1]);
  } else if (lang === "ts" || lang === "vue" || lang === "java" || lang === "dart" || lang === "php") {
    const m = header.match(/\b(?:extends|implements|with|on)\s+([^{]+)/);
    if (m) for (const base of m[1].replace(/\b(?:extends|implements|with|on)\b/g, ",").split(",")) add(base);
  } else if (lang === "csharp" || lang === "cpp" || lang === "kotlin" || lang === "swift") {
    const m = omitBalanced(header, "(", ")").match(/(?<!:):(?!:)\s*([^{;]+)/);
    if (m) for (const base of m[1].split(",")) add(base);
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

function braceBodyLines(lines, bounds, cleanCode, startLine) {
  const span = bounds?.braceSpan;
  if (!span) return lines;
  const openColumn = span.openOffset - (cleanCode.lastIndexOf("\n", span.openOffset - 1) + 1);
  const closeColumn = span.closeOffset - (cleanCode.lastIndexOf("\n", span.closeOffset - 1) + 1);
  return lines.map((line, index) => {
    const absoluteLine = startLine + index;
    if (absoluteLine < span.openLine || absoluteLine > span.closeLine) return "";
    let result = line;
    if (absoluteLine === span.closeLine) result = result.slice(0, closeColumn);
    if (absoluteLine === span.openLine) result = " ".repeat(openColumn + 1) + result.slice(openColumn + 1);
    return result;
  });
}

function extractDataFlowAndTouches({
  lang,
  decl,
  bounds,
  cleanCode,
  ownCleanLines,
  fullLexicalLines,
  params,
  promotedParams = [],
  refOutParams = [],
  bodyStartLineOffset,
  prevLines
}) {
  const sigHeader = ownCleanLines.slice(0, Math.max(1, bodyStartLineOffset)).join(" ");
  if (lang !== "python" && lang !== "ruby" && bounds?.hasBraceBody && bounds.braceSpan) {
    const startLine = bounds.endLine - ownCleanLines.length + 1;
    fullLexicalLines = braceBodyLines(fullLexicalLines || ownCleanLines, bounds, cleanCode, startLine);
    ownCleanLines = braceBodyLines(ownCleanLines, bounds, cleanCode, startLine);
    bodyStartLineOffset = bounds.braceSpan.openLine - startLine;
  }
  let innerLines = ownCleanLines.slice(bodyStartLineOffset);
  let innerBody = innerLines.join("\n");
  let fullLexicalInnerBody = (fullLexicalLines || ownCleanLines).slice(bodyStartLineOffset).join("\n");

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

  // 1. Check which input parameters are actually consumed in fullLexicalInnerBody (or C#/C++/Dart `: base(...)` / `: member(...)` ctor initializer)
  const ctorInitSlice =
    (decl.isConstructor || lang === "cpp" || lang === "csharp" || lang === "dart") && bounds?.paramSpan
      ? cleanCode.slice(bounds.paramSpan.closeOffset + 1, bounds.braceSpan ? bounds.braceSpan.openOffset : bounds.paramSpan.closeOffset + 200)
      : "";
  const paramSearchText = ctorInitSlice ? `${ctorInitSlice}\n${fullLexicalInnerBody}` : fullLexicalInnerBody;
  const promotedParamSet = new Set(promotedParams);
  const isStandardJsonReplacer =
    params.length === 2 && params[0] === "key" && params[1] === "value" && /^replacer/i.test(decl.name);
  const unusedParams = [];
  if (
    isFnOrMethod &&
    hasRealBody &&
    !bounds?.isTruncatedOrUncertain &&
    !isOverrideOrHook &&
    !isStandardJsonReplacer &&
    paramSearchText.trim().length > 0 &&
    !isIntentionalStubBody(fullLexicalInnerBody)
  ) {
    for (const p of params) {
      if (promotedParamSet.has(p)) continue;
      if (!makeIdentRegex(p, "", lang).test(paramSearchText)) unusedParams.push(p);
    }
  }

  // 2. Check if function returns or yields a non-void value (excluding returns inside nested anonymous closures)
  const outerControlBody = stripNestedClosureBodies(innerBody);
  const isVoidMethod =
    ((lang === "csharp" || lang === "java" || lang === "cpp") && /\bvoid\b/.test(sigHeader)) ||
    (lang === "dart" && /\b(?:void|Future\s*<\s*void\s*>)\b/.test(sigHeader)) ||
    (lang === "kotlin" && /:\s*Unit\b/.test(sigHeader)) ||
    (lang === "php" && /:\s*void\b/.test(sigHeader)) ||
    ((lang === "ts" || lang === "vue") && /:\s*(?:void\b|Promise\s*<\s*(?:void|undefined)\s*>)/.test(sigHeader));
  const isThrowExpression = /^\s*throw\b/.test(outerControlBody.trim());
  const hasExplicitReturn =
    !isVoidMethod &&
    (/\breturn[ \t]+[^\n;\s}#]+/.test(outerControlBody) ||
      (lang === "python" && /\byield\b/.test(outerControlBody)) ||
      (lang === "ruby" &&
        !decl.isConstructor &&
        outerControlBody.replace(/\bend\s*$/, "").trim().length > 0 &&
        !/^\s*(?:puts|print|p|pp|warn|raise)\b/.test(outerControlBody.trim())));
  const hasExprReturn =
    Boolean(bounds?.isExpressionBody) &&
    !isVoidMethod &&
    !isThrowExpression &&
    !/^(?:set[A-Z_][A-Za-z0-9_]*|[A-Za-z0-9_.]+\.(?:set|update|dispatch|emit|send|write|push|add|remove|delete|clear|wait|notify|notifyAll))\s*\(/.test(
      innerBody.trim()
    ) &&
    !/\.(?:wait|notify|notifyAll)\s*\(\s*\)\s*;?$/.test(innerBody.trim()) &&
    (lang === "ts" || lang === "vue" || lang === "python" || !/^[A-Za-z0-9_.]+\s*\([^)]*\)\s*;?$/.test(innerBody.trim()));
  const hasRustOrSwiftReturnType =
    (lang === "rust" || lang === "swift") && /->\s*(?!\(\s*\)|!|Void\b)[A-Za-z0-9_&*'\[\](<]/.test(sigHeader);
  const hasReturnValue =
    isFnOrMethod && (hasExplicitReturn || hasExprReturn || hasRustOrSwiftReturnType);

  const hasAssertionGuard =
    /\b(?:assert(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?|assert!(?:_eq|_ne)?|debug_assert!(?:_eq|_ne)?)\s*\(/.test(innerBody);
  const isPreconditionGuard =
    hasAssertionGuard ||
    (/\b(?:throw|raise|panic!)\b/.test(outerControlBody) &&
      (params.some((p) => {
        const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\breturn\\s+${esc}\\s*;?`).test(outerControlBody);
      }) ||
        /^(?:against|check|ensure|require|validate|assert|verify|handle)[A-Z_]/i.test(decl.name)));

  const canIgnoreReturnValue =
    /@CanIgnoreReturnValue|#\[allow\(unused_must_use\)\]/.test(prevLines) ||
    /\breturn[ \t]+(?:this|self)\b/.test(outerControlBody) ||
    ((lang === "ts" || lang === "vue") &&
      /^track[A-Z_]/.test(decl.name) &&
      /\$effect\b|\$derived\b|\bcreateEffect\b/.test(cleanCode)) ||
    isPreconditionGuard;

  // 3. Bare statement calls (`foo(bar);`) and dead local variable assignments (`const x = foo(bar);`)
  const bareIgnoredCalls = [];
  const deadLocalVars = [];

  if (isFnOrMethod && hasRealBody && !bounds?.isExpressionBody) {
    let lastCodeLineIdx = -1;
    if ((lang === "swift" && hasRustOrSwiftReturnType) || lang === "ruby") {
      for (let sIdx = ownCleanLines.length - 1; sIdx >= bodyStartLineOffset; sIdx--) {
        const t = ownCleanLines[sIdx].trim();
        if (t && t !== "}" && t !== "end") {
          lastCodeLineIdx = sIdx;
          break;
        }
      }
    }
    let prevNonEmptyLine = "";
    for (let idx = bodyStartLineOffset; idx < ownCleanLines.length; idx++) {
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
        /(?:[(,=\[+\-*/%?:&|^.\\]|->|=>|=\{|\breturn|\bthrow|\bawait)$/.test(prevNonEmptyLine) ||
        /^(?:[\]?.:&|+\-*/%]|==|!=|<=|>=|\bin\b|\binstanceof\b)/.test(nextNonEmptyLine);

      if (!isContinuation) {
        const bareM = line.match(
          /^(?:([A-Za-z_][A-Za-z0-9_]*)(?:\.|::))?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*(;)?$/
        );
        const isImplicitFinalReturn =
          ((lang === "swift" && hasRustOrSwiftReturnType) || lang === "ruby") &&
          idx === lastCodeLineIdx &&
          !bareM?.[4];
        const isImplicitBlockExprValue =
          ((lang === "kotlin" || lang === "rust" || lang === "ruby") &&
            !bareM?.[4] &&
            nextNonEmptyLine.startsWith("}")) ||
          (lang === "ruby" && !bareM?.[4] && /^(?:end|rescue|else|elsif|ensure)\b/.test(nextNonEmptyLine));
        if (
          bareM &&
          !isImplicitFinalReturn &&
          !isImplicitBlockExprValue &&
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
            const varRe = makeIdentRegex(varName, "", lang);
            const rightBound = "(?![A-Za-z0-9_$])";
            const earlierDeclRe = new RegExp(`\\b(?:const|let|var|auto)\\s+${esc}${rightBound}|(?<![A-Za-z0-9_$])${esc}\\s*:=`);
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

  // 5. Qualified member calls (`obj.method(`, `obj?.method(`, `this.#method(`, `a.b.method(`, `obj->method(`, or `Type::method(`)
  const qualifiedCalls = [];
  const qualCallRe =
    /(?:\b|\$)([A-Za-z_][A-Za-z0-9_]*)(?:(?:\??\.|->)(#?[A-Za-z_][A-Za-z0-9_]*))*(?:\??\.|->|::)(#?[A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
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

  const aliasRefVars = new Set();
  const aliasRefRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.value\b|(?:this|self|state|store)\.)/g;
  while ((m = aliasRefRe.exec(innerBody)) !== null) {
    aliasRefVars.add(m[1]);
  }

  const isNonLocalTarget = (recv) => {
    if (!recv) return false;
    if (/^(?:this|self|state|store|\$this)(?:\.|->|$)/.test(recv) || recv.startsWith("_")) return true;
    return !localVars.has(recv) || paramSet.has(recv) || aliasRefVars.has(recv);
  };

  for (const qc of qualifiedCalls) {
    if (localVars.has(qc.rootReceiver) && !paramSet.has(qc.rootReceiver)) {
      qc.isLocal = true;
    }
  }

  let hasInternalMutation =
    /(?:<<<|\b(?:this|self|state|store)(?:\.|->)#?[A-Za-z_][A-Za-z0-9_]*\s*(?:=|\+=|-=|\*=|\+\+|--)|\$this->[A-Za-z_][A-Za-z0-9_]*\s*(?:=|\+=|-=|\*=|\+\+|--)|(?<!@)@[a-zA-Z_][a-zA-Z0-9_]*\s*(?:=|\+=|-=)(?!=)|\b_[a-zA-Z0-9_]+\s*(?:=|\+=|-=|\+\+|--)(?!=)|\*[a-zA-Z_][a-zA-Z0-9_]*\s*=(?!=)|(?:\??\.|->)(?:Write|WriteLine|Send|Emit|Flush|Close|Dispose|Save|Execute|Commit|Publish|Broadcast|Dispatch|write|send|emit|flush|close|dispose|save|commit|publish|broadcast|dispatch|postMessage|setItem|removeItem|wait|notify|notifyAll|lock|unlock|signal|signalAll|focus|blur|hide|show|open|toggle|error|warn|info|debug|fatal|skip|readByte|readShort|readInt|readLong|go|back|forward|perform)(?:\s*<[^>]*>)?\s*\(|\b(?:emit|dispatch|go|resolve|reject|swrMutate|mutate|revalidate\w*|invalidate\w*|(?:on|set|handle|show|toast|open|close|hide|skip|notify|toggle)(?:[A-Z]|_[a-z])\w*|focus|blur|readByte|readShort|readInt|readLong|clearTimeout|clearInterval|setTimeout|setInterval|appendFileSync|writeFileSync|execFileSync|execSync|spawnSync|mkdirSync|rmSync|unlinkSync|copyFileSync|GetProcAddress|LoadLibrary\w*|SetProcessInformation|SetProcessDpiAwarenessContext|SetThreadDescription|ShellExecute\w*|CreateProcess\w*|SetEnvironmentVariable\w*|putenv|_putenv\w*|setenv|unsetenv|Interlocked[A-Z]\w*|__atomic_\w+|__sync_\w+|atomic_(?:store\w*|exchange\w*|fetch_\w+|compare_exchange_\w+|flag_\w+)|cudaMemcpy\w*|cudaMemset\w*|cudaFree\w*|cudaStreamSynchronize|cudaDeviceSynchronize)(?:\s*<[^>]*>)?\s*\()/.test(
      innerBody
    ) ||
    (lang === "ruby" &&
      (/(?:\.[a-z_][a-z0-9_]*!\s*(?:\(|$)|\b[a-zA-Z_][a-zA-Z0-9_]*\s*<<\s*\S)/m.test(innerBody) ||
        /\byield\b/.test(innerBody))) ||
    params.some((p) => {
      if (p.length <= 1) return false;
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![A-Za-z0-9_$.])${esc}\\s*\\(`).test(innerBody);
    });

  if (!hasInternalMutation) {
    const objAssignRe = /\bObject\.assign\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    while ((m = objAssignRe.exec(innerBody)) !== null) {
      if (isNonLocalTarget(m[1])) {
        hasInternalMutation = true;
        break;
      }
    }
  }
  if (!hasInternalMutation) {
    const propMutRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\s*(?:=|\+=|-=|\*=|\+\+|--)(?!=)/g;
    while ((m = propMutRe.exec(innerBody)) !== null) {
      if (isNonLocalTarget(m[1])) {
        hasInternalMutation = true;
        break;
      }
    }
  }
  if (!hasInternalMutation) {
    const collMutRe =
      /((?:(?:this|self)(?:\.|->)|\$this->)?[A-Za-z_$][A-Za-z0-9_$]*)(?:\??\.|->)(?:Add|Remove|Clear|Insert|Push|Pop|Set|Delete|Append|add|remove|clear|insert|push|pop|set|delete|append|splice|shift|unshift|sort|reverse|merge|update|delete_if|keep_if)(?:\s*<[^>]*>)?\s*(?:\(|\{|\bdo\b)/g;
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
  const refOutParamSet = new Set(refOutParams);
  if (
    !hasInternalMutation &&
    lang !== "python" &&
    lang !== "ruby" &&
    lang !== "php"
  ) {
    const outerAssignRe = /(?:^\s*|[({\s;])([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|\+=|-=)(?![=>])[^,\n;]*(?:;|\)|\s*$)/gm;
    while ((m = outerAssignRe.exec(innerBody)) !== null) {
      const lhs = m[1];
      if (
        !/^(?:return|case|default|throw|const|let|var|auto|mut|val|if|while|for)$/.test(lhs) &&
        !localVars.has(lhs) &&
        (!paramSet.has(lhs) || refOutParamSet.has(lhs))
      ) {
        hasInternalMutation = true;
        break;
      }
    }
  } else if (!hasInternalMutation && lang === "php" && refOutParamSet.size > 0) {
    for (const rp of refOutParamSet) {
      const rpEsc = rp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\$${rpEsc}\\s*(?:=|\\+=|-=|\\.=)(?!=)`).test(innerBody)) {
        hasInternalMutation = true;
        break;
      }
    }
  }

  const writes = new Set();
  const delegatedWrites = new Set();
  const reads = new Set();
  const parameterFieldReads = [];
  const parameterReadRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)(?:\??\.|->)(#?[A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = parameterReadRe.exec(innerBody)) !== null) {
    const after = innerBody.slice(m.index + m[0].length);
    if (paramSet.has(m[1]) && !/^\s*(?:=(?!=)|\()/.test(after)) {
      parameterFieldReads.push({ parameter: m[1], field: m[2] });
    }
  }
  const returnsOrPassesLocalState = /\breturn\s+state\b|&\s*state\b/.test(fullBody);
  const DOM_CALLBACK_PROPS = /^(?:onmessage|onerror|onclose|onopen|onload|onabort|onupgradeneeded|onsuccess|onreadystatechange)$/;
  const writeRe =
    /(?:\b(this|self|state|store)|(\$this))(?:(?:\.|->)(#?[a-zA-Z_][a-zA-Z0-9_]*))?(?:\.|->)(#?[a-zA-Z_][a-zA-Z0-9_]*)\s*(=|\+=|-=)(?!=)/g;
  while ((m = writeRe.exec(fullBody)) !== null) {
    const rootObj = m[1] || m[2];
    const subObj = m[3];
    const field = m[4];
    const op = m[5];
    if (subObj && subObj.length > 1) reads.add(subObj);
    if (DOM_CALLBACK_PROPS.test(field)) continue;
    if (subObj && subObj !== "state" && subObj !== "store" && (field === "current" || field === "value")) {
      continue;
    }
    const afterAssign = fullBody.slice(m.index + m[0].length, m.index + m[0].length + 60);
    // Ignore constructor method-binding `this.fn = this.fn.bind(this)`
    const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*(?:this|self)\\.${fieldEsc}\\.bind\\s*\\(`).test(afterAssign)) {
      continue;
    }
    if (field.length > 1) {
      writes.add(field);
      if (subObj && subObj !== "state" && subObj !== "store") {
        delegatedWrites.add(field);
      }
    }
    if ((op === "+=" || op === "-=" || (rootObj === "state" && returnsOrPassesLocalState)) && field.length > 1) {
      reads.add(field);
    }
  }

  // Strip only the LHS of pure `=` assignments so any other read of the same field in the same method is preserved
  const bodyWithoutWriteLhs = fullBody.replace(
    /(?:\b(this|self|state|store)|(\$this))(?:(?:\.|->)#?[a-zA-Z_][a-zA-Z0-9_]*)?(?:\.|->)(#?[a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g,
    " ="
  );
  const readRe =
    /(?:\b(this|self|state|store|ctx|[A-Z][A-Za-z0-9_]*)|(\$this))(?:\??\.|->)(#?[a-zA-Z_][a-zA-Z0-9_]*)(?:(?:\??\.|->)(#?[a-zA-Z_][a-zA-Z0-9_]*))?/g;
  while ((m = readRe.exec(bodyWithoutWriteLhs)) !== null) {
    const f1 = m[3];
    const f2 = m[4];
    const afterMatch = bodyWithoutWriteLhs.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const endsWithCallParen = /^\s*(?:\?\.)?\s*\(/.test(afterMatch);
    if (f1 && f1.length > 1 && (Boolean(f2) || !endsWithCallParen)) reads.add(f1);
    if (f2 && f2.length > 1 && !endsWithCallParen) reads.add(f2);
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

  const upperConstantsRead = new Set();
  const bodyWithoutConstDecl = innerBody.replace(/\b(?:const|let|var|static|final|#define)\s+[A-Z][A-Z0-9_]*\b/g, " ");
  const upperConstRe = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((m = upperConstRe.exec(bodyWithoutConstDecl)) !== null) {
    if (!/^(?:TRUE|FALSE|NULL|NONE|EOF|OK|ERR| HTTP_|JSON|UTF8|UTF_8)$/.test(m[1])) {
      upperConstantsRead.add(m[1]);
    }
  }

  return {
    unusedParams,
    parameterFieldReads,
    readParams: hasRealBody && !bounds?.isTruncatedOrUncertain
      ? params.filter((p) => makeIdentRegex(p, "", lang).test(paramSearchText))
      : null,
    hasReturnValue,
    canIgnoreReturnValue,
    hasInternalMutation,
    bareIgnoredCalls,
    deadLocalVars,
    localVars,
    conditionalCount,
    qualifiedCalls,
    upperConstantsRead: Array.from(upperConstantsRead),
    writes: Array.from(writes),
    delegatedWrites: Array.from(delegatedWrites),
    reads: Array.from(reads)
  };
}

function preprocessSfcContent(content) {
  const chars = new Array(content.length);
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    chars[i] = c === "\n" || c === "\r" ? c : " ";
  }

  const scriptRanges = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(content)) !== null) {
    const fullMatch = m[0];
    const body = m[1];
    const openEndOffset = m.index + fullMatch.indexOf(">") + 1;
    for (let k = 0; k < body.length; k++) {
      chars[openEndOffset + k] = body[k];
    }
    scriptRanges.push([m.index, m.index + fullMatch.length]);
  }

  // Extract template event handlers & bound expressions outside <script> and <style>
  const blankMarkup = (value) => value.replace(/[^\r\n]/g, " ");
  let markup = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blankMarkup)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blankMarkup)
    .replace(/<!--[\s\S]*?-->/g, blankMarkup);

  const sfcEventIdents = new Set();
  const sfcTemplateIdents = new Set();
  const sfcMemberReads = new Set();
  const sfcTemplateEventHandlers = [];

  const addExprIdents = (expr, targetSet) => {
    for (const id of expr.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []) {
      if (!/^(?:true|false|null|undefined|event|\$event|this|return|if|else|new)$/.test(id)) {
        targetSet.add(id);
      }
    }
    let pm;
    const propRe = /(?:\??\.)([a-zA-Z_$][a-zA-Z0-9_$]*)\b(?!\s*\()/g;
    while ((pm = propRe.exec(expr)) !== null) {
      if (pm[1].length > 1) sfcMemberReads.add(pm[1]);
    }
  };

  // Keep the lexical template scope while walking tags.  In particular, a
  // `v-for` alias remains in scope for its descendants, so an event handler
  // with the same spelling must not be resolved to a script binding.
  const templateTagRe = /<(\/)?([A-Za-z][A-Za-z0-9_.:-]*)(\s[^<>]*?)?(\/?)>/g;
  const templateScope = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  while ((m = templateTagRe.exec(markup)) !== null) {
    const isCloseTag = Boolean(m[1]);
    const tagName = m[2];
    if (isCloseTag) {
      for (let index = templateScope.length - 1; index >= 0; index--) {
        if (templateScope[index].tagName.toLowerCase() === tagName.toLowerCase()) {
          templateScope.length = index;
          break;
        }
      }
      continue;
    }

    const attrs = m[3] || "";
    const loopLocals = new Set();
    const forMatch = attrs.match(/\bv-for\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    const forExpr = forMatch?.[1] ?? forMatch?.[2] ?? "";
    const forAlias = forExpr.match(/^\s*(?:\(([^)]*)\)|([A-Za-z_$][A-Za-z0-9_$]*))\s+(?:in|of)\b/);
    for (const local of (forAlias?.[1] || forAlias?.[2] || "").split(",")) {
      const name = local.trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) loopLocals.add(name);
    }
    const scopedLocals = new Set(templateScope.flatMap((scope) => [...scope.locals]));
    for (const local of loopLocals) scopedLocals.add(local);
    const eventAttrRe = /(?:@|v-on:)[A-Za-z0-9_.:-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let event;
    while ((event = eventAttrRe.exec(attrs)) !== null) {
      const expr = event[1] ?? event[2] ?? "";
      addExprIdents(expr, sfcEventIdents);
      const handler = expr.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\([^]*\))?\s*$/)?.[1];
      if (handler && !scopedLocals.has(handler)) {
        const eventOffset = m.index + event.index;
        sfcTemplateEventHandlers.push({ name: handler, line: content.slice(0, eventOffset).split(/\r?\n/).length });
      }
    }

    if (m[4] !== "/" && !voidTags.has(tagName.toLowerCase())) {
      templateScope.push({ tagName, locals: loopLocals });
    }
  }

  const bindAttrRe = /(?:v-bind:|v-model(?::[A-Za-z0-9_-]+)?|v-if|v-else-if|v-show|v-for|bind:|use:|class:|:)[A-Za-z0-9_.-]*\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  while ((m = bindAttrRe.exec(markup)) !== null) {
    const expr = m[1] ?? m[2] ?? m[3] ?? "";
    // The left side of `item in items` declares a template-local alias; it
    // is not a direct render reference to a same-named script symbol.
    const renderedExpr = /\bv-for\s*=/.test(m[0])
      ? (expr.match(/\b(?:in|of)\s+([\s\S]*)$/)?.[1] || "")
      : expr;
    addExprIdents(renderedExpr, sfcTemplateIdents);
  }

  const mustacheRe = /\{\{([\s\S]*?)\}\}|\{([^{}<>"']+)\}/g;
  while ((m = mustacheRe.exec(markup)) !== null) {
    addExprIdents(m[1] ?? m[2] ?? "", sfcTemplateIdents);
  }

  const compTagRe = /<([A-Z][A-Za-z0-9_]*)\b/g;
  while ((m = compTagRe.exec(markup)) !== null) {
    sfcTemplateIdents.add(m[1]);
  }

  return {
    scriptContent: chars.join(""),
    hasScriptBlock: scriptRanges.length > 0,
    sfcEventIdents,
    sfcTemplateIdents,
    sfcMemberReads,
    sfcTemplateEventHandlers
  };
}

function extractFileImports(lang, content, relPath = "") {
  const importedStems = new Set();
  const importedPaths = [];
  const reExportedPaths = [];
  const reExportedStems = new Set();
  // Source identifiers such as toString, constructor and __proto__ are ordinary
  // names, not inherited Object properties or prototype setters.
  const importAliases = Object.create(null);
  const importBindings = [];
  const exportBindings = [];
  let m;
  if (lang === "ts" || lang === "vue") {
    const bindingsRe = /^\s*import\s+(?!type\b)((?:[A-Za-z_$][A-Za-z0-9_$]*(?:\s*,\s*)?)?(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?)\s+from\s*["']([^"']+)["']/gm;
    while ((m = bindingsRe.exec(content)) !== null) {
      const defaultName = m[1].match(/^([A-Za-z_$][A-Za-z0-9_$]*)\b/)?.[1];
      if (defaultName) importBindings.push({ local: defaultName, imported: "default", source: m[2] });
      const namespace = m[1].match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (namespace) importBindings.push({ local: namespace[1], imported: "*", source: m[2] });
      const named = m[1].match(/\{([^}]+)\}/)?.[1] || "";
      for (const spec of named.split(",")) {
        const binding = spec.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
        if (binding) importBindings.push({ local: binding[2] || binding[1], imported: binding[1], source: m[2] });
      }
    }
    const re = /\bfrom\s+["']([^"']+)["']/g;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      const base = path.basename(m[1], path.extname(m[1]));
      if (base) importedStems.add(base);
    }
    const namedImportRe = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    while ((m = namedImportRe.exec(content)) !== null) {
      for (const spec of m[1].split(",")) {
        const cleaned = spec.replace(/^\s*type\s+/, "").trim();
        const aliasM = cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
        if (aliasM && aliasM[1] !== "default") {
          importAliases[aliasM[2]] = aliasM[1];
        }
      }
    }
    const reExportStarRe = /\bexport\s+\*\s*(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*)?from\s*["']([^"']+)["']/g;
    while ((m = reExportStarRe.exec(content)) !== null) {
      reExportedPaths.push(m[2]);
      exportBindings.push({ exported: m[1] || "*", imported: "*", source: m[2] });
    }
    const reExportNamedRe = /\bexport\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    while ((m = reExportNamedRe.exec(content)) !== null) {
      reExportedPaths.push(m[2]);
      if (/\bexport\s+type\s*\{/.test(m[0])) continue;
      for (const spec of m[1].split(",")) {
        const cleaned = spec.replace(/^\s*type\s+/, "").trim();
        const aliasM = cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
        if (!/^\s*type\s+/.test(spec) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned)) exportBindings.push({ exported: cleaned, imported: cleaned, source: m[2] });
        else if (aliasM && !/^\s*type\s+/.test(spec)) exportBindings.push({ exported: aliasM[2], imported: aliasM[1], source: m[2] });
        if (aliasM && aliasM[1] !== "default") {
          importAliases[aliasM[2]] = aliasM[1];
        }
      }
    }
    for (const match of content.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=;|$)/gm)) {
      exportBindings.push({ exported: match[1], imported: match[2], source: null });
    }
    for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}\s*(?=;|$)/gm)) {
      for (const spec of match[1].split(",")) {
        const binding = spec.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
        if (binding) exportBindings.push({ exported: binding[2] || binding[1], imported: binding[1], source: null });
      }
    }
  } else if (lang === "rust") {
    // Rust aliases and nested use trees are resolved with their module/block
    // scope, rather than flattening every imported name into this file.
  } else if (lang === "python") {
    const isInitPy = /(?:^|\/|\\)__init__\.py$/i.test(relPath);
    const re = /\b(?:from|import)\s+(\.*[a-zA-Z0-9_.]+)/g;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      if (isInitPy) reExportedPaths.push(m[1]);
      const parts = m[1].replace(/^\.+/, "").split(".");
      if (parts[parts.length - 1]) {
        importedStems.add(parts[parts.length - 1]);
        if (isInitPy) reExportedStems.add(parts[parts.length - 1]);
      }
    }
    const pyFromImportRe = /\bfrom\s+\.*[a-zA-Z0-9_.]*\s+import\s+(?:\(([^)]+)\)|([^\n;#]+))/g;
    while ((m = pyFromImportRe.exec(content)) !== null) {
      const listStr = m[1] || m[2] || "";
      for (const spec of listStr.split(",")) {
        const trimmed = spec.trim();
        const aliasM = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
        if (aliasM) {
          importAliases[aliasM[2]] = aliasM[1];
          importedStems.add(aliasM[1]);
        } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
          importedStems.add(trimmed);
          if (isInitPy) reExportedStems.add(trimmed);
        }
      }
    }
  } else if (lang === "cpp") {
    const re = /^\s*#\s*include\s*["<]([^">]+)[">]/gm;
    while ((m = re.exec(content)) !== null) {
      importedPaths.push(m[1]);
      const base = path.basename(m[1], path.extname(m[1]));
      if (base) importedStems.add(base);
    }
  } else if (lang === "php") {
    const re = /\buse\s+(?:[A-Za-z0-9_]+\\)+([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?|(?:require|include)(?:_once)?\s*\(?["']([^"']+)["']/g;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) {
        importedStems.add(m[1]);
        if (m[2]) importAliases[m[2]] = m[1];
      }
      if (m[3]) {
        importedPaths.push(m[3]);
        const base = path.basename(m[3], path.extname(m[3]));
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
  } else if (lang === "dart") {
    const re = /\b(import|export|part)\s+["']([^"']+)["']/g;
    while ((m = re.exec(content)) !== null) {
      const spec = m[2].startsWith("package:") ? m[2].replace(/^package:[^/]+\//, "lib/") : m[2];
      importedPaths.push(spec);
      if (m[1] === "export" || m[1] === "part") reExportedPaths.push(spec);
      const base = path.basename(spec, path.extname(spec));
      if (base) {
        importedStems.add(base);
        if (m[1] === "export" || m[1] === "part") reExportedStems.add(base);
      }
    }
  } else if (lang === "java" || lang === "kotlin") {
    const re = /\bimport\s+(?:static\s+)?((?:[A-Za-z0-9_]+\.)+)([A-Za-z0-9_*]+)(?:\s+as\s+([A-Za-z0-9_]+))?/g;
    while ((m = re.exec(content)) !== null) {
      importBindings.push({ local: m[3] || m[2], imported: m[1] + m[2], source: m[1] + m[2] });
      if (m[2] && m[2] !== "*") {
        importedStems.add(m[2]);
        if (m[3]) importAliases[m[3]] = m[2];
      } else if (m[1]) {
        const pkgParts = m[1].replace(/\.$/, "").split(".");
        if (pkgParts[pkgParts.length - 1]) importedStems.add(pkgParts[pkgParts.length - 1]);
      }
    }
  } else if (lang === "csharp") {
    const re = /\busing\s+(?:static\s+)?(?:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?(?:[A-Za-z0-9_]+\.)*([A-Za-z0-9_]+)\s*;/g;
    while ((m = re.exec(content)) !== null) {
      if (m[2]) {
        importedStems.add(m[2]);
        if (m[1]) importAliases[m[1]] = m[2];
      }
    }
  }
  return {
    importedStems: Array.from(importedStems),
    importedPaths,
    reExportedPaths,
    reExportedStems: Array.from(reExportedStems),
    importAliases,
    importBindings,
    exportBindings
  };
}

// JSX elements are component references, not ordinary positional function calls.
// Keep their local import binding and source line so resolution cannot connect a
// same-named component from a different import or invent argument consumption.
function extractJsxReferences(text, startLine = 1) {
  const references = [];
  const tags = /<([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)(?=[\s/>])/g;
  let match;
  let line = startLine;
  let previousOffset = 0;
  while ((match = tags.exec(text)) !== null) {
    for (let i = previousOffset; i < match.index; i++) if (text[i] === "\n") line++;
    previousOffset = match.index;
    if (/[A-Za-z0-9_$]/.test(text[match.index - 1] || "")) continue;
    let braces = 0;
    let end = tags.lastIndex;
    for (; end < text.length; end++) {
      if (text[end] === "{") braces++;
      else if (text[end] === "}") braces--;
      else if (text[end] === ">" && braces === 0) break;
    }
    if (end === text.length) continue;
    const selfClosing = /\/\s*$/.test(text.slice(tags.lastIndex, end));
    if (!selfClosing && !text.slice(end + 1).includes(`</${match[1]}`)) continue;
    const [local, member] = match[1].split(".");
    references.push({ local, member: member || null, line });
  }
  return references;
}

function extractJsxLocalBindings(text) {
  const bindings = [];
  const parseReference = (expression) => {
    const root = expression.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (!root) return null;
    let tail = expression.trim().slice(root[0].length);
    const segments = [];
    while (tail.trim()) {
      const member = tail.match(/^\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
      const index = tail.match(/^\s*\[\s*(?:["']([A-Za-z_$][A-Za-z0-9_$]*)["']|([A-Za-z_$][A-Za-z0-9_$]*))\s*\]/);
      if (member) { segments.push(member[1]); tail = tail.slice(member[0].length); }
      else if (index) { segments.push(index[1] || "*"); tail = tail.slice(index[0].length); }
      else return null;
    }
    return { root: root[1], segments };
  };
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;\n]+)/g)) {
    const ternary = match[2].match(/^[^?]+\?([^:]+):(.+)$/);
    const options = (ternary ? [ternary[1], ternary[2]] : [match[2]]).map(parseReference);
    if (options.every(Boolean)) bindings.push({ local: match[1], options, conditional: Boolean(ternary) });
  }
  return bindings;
}

function extractBalancedCallArgs(text, openParenIdx) {
  if (openParenIdx < 0 || text[openParenIdx] !== "(") return "";
  let depth = 0;
  const maxEnd = Math.min(text.length, openParenIdx + 360);
  for (let i = openParenIdx; i < maxEnd; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openParenIdx + 1, i);
    }
  }
  return text.slice(openParenIdx + 1, maxEnd);
}

function splitCallArguments(argText) {
  if (!argText || !argText.trim()) return [];
  const parts = [];
  let p = 0;
  let b = 0;
  let c = 0;
  let last = 0;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];
    if (ch === "(") p++;
    else if (ch === ")" && p > 0) p--;
    else if (ch === "[") b++;
    else if (ch === "]" && b > 0) b--;
    else if (ch === "{") c++;
    else if (ch === "}" && c > 0) c--;
    else if (ch === "," && p === 0 && b === 0 && c === 0) {
      parts.push(argText.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(argText.slice(last));
  return parts;
}

function unwrapGroupedArgument(text) {
  let value = text.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0, closesAtEnd = false;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") depth--;
      if (depth === 0) { closesAtEnd = i === value.length - 1; break; }
    }
    if (!closesAtEnd) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function extractArgTokensFromSlice(argText) {
  const parts = splitCallArguments(argText);
  const out = [];
  for (const raw of parts.slice(0, 8)) {
    const trimmed = unwrapGroupedArgument(raw);
    if (!trimmed) continue;
    const propChainM = trimmed.match(/^(?:await\s+)?((?:this|self|state|store|ctx|config|\$this)(?:\.|->)#?[A-Za-z_$][A-Za-z0-9_$.]*|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)$/);
    if (propChainM) {
      out.push(propChainM[1]);
      continue;
    }
    const identM = trimmed.match(/^(?:&(?:mut\s+)?|\*)?([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (identM && !/^(?:true|false|null|None|nil|undefined)$/.test(identM[1])) {
      out.push(identM[1]);
      continue;
    }
    for (const id of (trimmed.match(/(?:this|self|state|store|config)\.[A-Za-z_$][A-Za-z0-9_$]*|\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || []).slice(0, 3)) {
      if (!/^(?:true|false|null|None|nil|undefined|new|await|return)$/.test(id)) {
        out.push(id);
      }
    }
  }
  return Array.from(new Set(out)).slice(0, 8);
}

function extractCallPayloadFields(commentStripped, matchStartIdx) {
  const openParenIdx = commentStripped.indexOf("(", matchStartIdx);
  if (openParenIdx < 0) return [];
  const callArgs = extractBalancedCallArgs(commentStripped, openParenIdx);
  if (!callArgs || !callArgs.includes("{")) return [];

  const HTTP_OPT_KEYS = /^(?:method|headers|body|signal|credentials|mode|cache|redirect|referrer|integrity|keepalive|params|responseType|url|baseURL|timeout)$/;
  const fields = new Set();
  const braceBlocks = [];
  let depth = 0;
  let blockStart = -1;
  for (let i = 0; i < callArgs.length; i++) {
    if (callArgs[i] === "{") {
      if (depth === 0) blockStart = i + 1;
      depth++;
    } else if (callArgs[i] === "}") {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        braceBlocks.push(callArgs.slice(blockStart, i));
        blockStart = -1;
      }
    }
  }

  for (const blk of braceBlocks) {
    // Check if there is a nested JSON.stringify({ ... }) or body: { ... }
    const nestedBodyM = blk.match(/\b(?:body|data|payload)\s*:\s*(?:JSON\.stringify\s*\(\s*)?\{([^}]*)\}/);
    const targetSlice = nestedBodyM ? nestedBodyM[1] : blk;
    let km;
    const keyValRe = /(?:^|[,{])\s*["']?([a-zA-Z_$][a-zA-Z0-9_$]*)["']?(?=\s*(?::|,|$))/g;
    while ((km = keyValRe.exec(targetSlice)) !== null) {
      const k = km[1];
      if (k && !HTTP_OPT_KEYS.test(k) && !/^(?:true|false|null|undefined)$/.test(k)) {
        fields.add(k);
      }
    }
  }
  return Array.from(fields).slice(0, 16);
}

function extractCallSitesForSymbol({
  lang,
  ownCleanLines,
  startLine,
  bodyStartLineOffset,
  declName,
  params,
  localVars,
  importAliases,
  isExpressionBody
}) {
  const sites = [];
  const SKIP_CALLEES =
    /^(?:if|for|foreach|while|switch|catch|return|new|typeof|sizeof|nameof|await|lock|using|Some|None|Ok|Err|vec|format|println|eprintln|super|base|this|self)$/;
  const isIndentLang = lang === "python" || lang === "ruby";
  const condStack = [];
  let braceDepth = 0;
  let lastPoppedCondHeader = null;
  let lastSingleLineCondHeader = null;
  const startIdx = isExpressionBody ? 0 : bodyStartLineOffset;
  const fullJoined = ownCleanLines.join("\n");
  let nextLineOffset = 0;
  const lineOffsets = ownCleanLines.map((line) => {
    const offset = nextLineOffset;
    nextLineOffset += line.length + 1;
    return offset;
  });

  for (let relIdx = startIdx; relIdx < ownCleanLines.length; relIdx++) {
    const rawLine = ownCleanLines[relIdx];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const absLine = startLine + relIdx;
    const indent = (rawLine.match(/^\s*/)?.[0] || "").length;

    if (isIndentLang) {
      const isContinuationBranch = /^(?:elif|else|when)\b/.test(trimmed);
      while (condStack.length > 0 && indent <= condStack[condStack.length - 1].indent) {
        const popped = condStack.pop();
        if (isContinuationBranch && indent === popped.indent) {
          lastPoppedCondHeader = popped.headerLine;
        }
      }
      if (/^(?:if|elif|else|case|match|when)\b/.test(trimmed)) {
        const headerLine = isContinuationBranch && lastPoppedCondHeader ? lastPoppedCondHeader : absLine;
        condStack.push({ indent, headerLine });
        lastPoppedCondHeader = null;
      } else {
        lastPoppedCondHeader = null;
      }
    } else {
      let lineClosesLeadingBrace = 0;
      for (let cIdx = 0; cIdx < trimmed.length && trimmed[cIdx] === "}"; cIdx++) {
        lineClosesLeadingBrace++;
      }
      let poppedHeaderOnThisLine = null;
      for (let c = 0; c < lineClosesLeadingBrace; c++) {
        braceDepth = Math.max(0, braceDepth - 1);
        while (condStack.length > 0 && condStack[condStack.length - 1].braceDepth > braceDepth) {
          poppedHeaderOnThisLine = condStack.pop().headerLine;
        }
      }
      if (poppedHeaderOnThisLine !== null) {
        lastPoppedCondHeader = poppedHeaderOnThisLine;
      }

      const afterLeadingClose = trimmed.slice(lineClosesLeadingBrace).trim();
      const isElseCont = /^(?:else\b|case\b|default\s*:)/.test(afterLeadingClose);
      const isCondStart = /^(?:if|switch|match)\b|\bmatch\b[^{;]*\{\s*$/.test(afterLeadingClose) || isElseCont;

      let netRemainingBraces = 0;
      for (let cIdx = lineClosesLeadingBrace; cIdx < trimmed.length; cIdx++) {
        if (trimmed[cIdx] === "{") netRemainingBraces++;
        else if (trimmed[cIdx] === "}") netRemainingBraces--;
      }

      if (isCondStart) {
        const inheritedHeader =
          isElseCont && (lastPoppedCondHeader || lastSingleLineCondHeader)
            ? lastPoppedCondHeader || lastSingleLineCondHeader
            : absLine;
        if (netRemainingBraces > 0) {
          condStack.push({ braceDepth: braceDepth + 1, headerLine: inheritedHeader });
          lastSingleLineCondHeader = null;
        } else if (!/^case\b|^default\s*:/.test(afterLeadingClose)) {
          lastSingleLineCondHeader = inheritedHeader;
        }
        lastPoppedCondHeader = null;
      } else {
        lastPoppedCondHeader = null;
        lastSingleLineCondHeader = null;
      }

      braceDepth = Math.max(0, braceDepth + netRemainingBraces);
      while (condStack.length > 0 && condStack[condStack.length - 1].braceDepth > braceDepth) {
        lastPoppedCondHeader = condStack.pop().headerLine;
      }
    }

    const inlineConditional =
      /\?[^:]+:|(?:\|\||&&)\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\(/.test(trimmed) ||
      Boolean(lastSingleLineCondHeader);
    const inConditionalBranch = condStack.length > 0 || inlineConditional;
    const branchHeaderLine =
      condStack.length > 0
        ? condStack[condStack.length - 1].headerLine
        : lastSingleLineCondHeader || (inlineConditional ? absLine : null);

    // Extract direct & qualified calls on this line
    const lineCallRe =
      /(?:(?:\b|\$)([A-Za-z_][A-Za-z0-9_]*)(?:(?:\??\.|->)#?[A-Za-z_][A-Za-z0-9_]*)*(?:\??\.|->|::))?(?:\bnew\s+)?(#?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:(?:::)?<[^;{}()=]+>\s*|<<<[^;{}]+>>>\s*)?\(/g;
    let cm;
    while ((cm = lineCallRe.exec(rawLine)) !== null) {
      // Preserve the whole Rust member receiver. `self.inner.run()` is not
      // dispatch on `self`; its field type must be resolved independently.
      const receiver = lang === "rust" && cm[1] && !cm[0].includes("::")
        ? cm[0].slice(0, cm[0].lastIndexOf(cm[2])).replace(/(?:\?\.|\.|->)\s*$/, "").trim()
        : cm[1] || null;
      const rawCallee = cm[2];
      if (!rawCallee || (rawCallee === declName && !(lang === "rust" && receiver)) ||
        (SKIP_CALLEES.test(rawCallee) && !(lang === "rust" && rawCallee === "new" && receiver))) continue;
      const callee = importAliases[rawCallee] || rawCallee;
      const openIdx = rawLine.indexOf("(", cm.index + cm[0].length - 1);
      const callOpen = openIdx >= 0 ? openIdx : rawLine.indexOf("(", cm.index);
      const callText = fullJoined.slice(lineOffsets[relIdx], lineOffsets[relIdx] + callOpen + 361);
      const argSlice = extractBalancedCallArgs(callText, callOpen);
      const passedArgs = extractArgTokensFromSlice(argSlice);
      const argumentParts = splitCallArguments(argSlice);
      // Keep literals/complex expressions as null slots; never flatten or deduplicate positions.
      const positionalArgs = argumentParts.map((part) => {
        const ref = unwrapGroupedArgument(part);
        return /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:(?:\.|->)#?[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(ref)
          && !/^(?:true|false|null|None|nil|undefined)$/.test(ref) ? ref : null;
      });
      const argumentMapping = callText[callOpen + argSlice.length + 1] === ")"
        && !argumentParts.some((part) => /^(?:\.\.\.|\*|[A-Za-z_$][A-Za-z0-9_$]*\s*[:=](?!=))/.test(part.trim()))
        ? "POSITIONAL" : "UNRESOLVED";

      const prefixBeforeCall = rawLine.slice(0, cm.index).trim();
      let returnFlow = "CONSUMED_EXPR";
      if (isExpressionBody && relIdx === startIdx && !prefixBeforeCall) {
        returnFlow = "RETURNED";
      } else if (/\breturn\s*(?:await\s*)?$/.test(prefixBeforeCall) || /=>\s*(?:await\s*)?$/.test(prefixBeforeCall)) {
        returnFlow = "RETURNED";
      } else {
        const assignM = prefixBeforeCall.match(/([A-Za-z_$#][A-Za-z0-9_$.#]*)\s*(?::(?!:)[^=]+)?(?::=|=|\+=)\s*(?:await\s*)?$/);
        if (assignM) {
          returnFlow = `ASSIGNED:${assignM[1]}`;
        } else if (!prefixBeforeCall || /^(?:void|await)\b/.test(prefixBeforeCall)) {
          returnFlow = "DISCARDED_BARE";
        }
      }

      sites.push({
        callee,
        rawCallee,
        receiver,
        ...(lang === "rust" ? { rustPath: ((rawLine.slice(0, cm.index).match(/((?:::)?(?:[A-Za-z_][A-Za-z0-9_]*::)+|::)$/)?.[1] || "") +
          (receiver && cm[0].includes("::") ? receiver + "::" : "") + rawCallee) } : {}),
        line: absLine,
        passedArgs,
        positionalArgs,
        argumentMapping,
        returnFlow,
        inConditionalBranch,
        branchHeaderLine,
        isRegistrationRef: false
      });

      // A qualified function item passed as an argument retains its module
      // path. Registering it is candidate exposure, not proof of invocation.
      let callbackOffset = 0;
      let callbackArgumentIndex = -1;
      if (lang === "rust" && callText[callOpen + argSlice.length + 1] === ")") for (const part of argumentParts) {
        callbackArgumentIndex++;
        const reference = part.trim();
        const referenceOffset = callbackOffset + part.indexOf(reference);
        callbackOffset += part.length + 1;
        if (!/^(?:r#)?[A-Za-z_]\w*(?:::(?:r#)?[A-Za-z_]\w*)*$/.test(reference) ||
          /^(?:true|false|self|Self)$/.test(reference) || localVars.has(reference) || params.includes(reference)) continue;
        const name = reference.split("::").at(-1).replace(/^r#/, "");
        sites.push({ callee: name, rawCallee: name, receiver: null, rustPath: reference,
          line: absLine + argSlice.slice(0, referenceOffset).split("\n").length - 1,
          passedArgs: [], returnFlow: "REGISTERED_REF", inConditionalBranch,
          branchHeaderLine, isRegistrationRef: true,
          registeredBy: { rawCallee, receiver, rustPath: receiver && cm[0].includes('::') ? `${receiver}::${rawCallee}` : rawCallee,
            line: absLine, argumentIndex: callbackArgumentIndex } });
      }

      if (
        lang !== "rust" && receiver &&
        !/^(?:this|self|super|base)$/.test(receiver) &&
        !localVars.has(receiver) &&
        !params.includes(receiver) &&
        (/^[A-Z]/.test(receiver) || Boolean(importAliases[receiver]))
      ) {
        const resolvedRecv = importAliases[receiver] || receiver;
        sites.push({
          callee: resolvedRecv,
          rawCallee: receiver,
          receiver: null,
          line: absLine,
          passedArgs,
          returnFlow,
          inConditionalBranch,
          branchHeaderLine,
          isRegistrationRef: false
        });
      }
    }

    // First-class registration / dispatch map / callback references on this line
    const lineRefRe = /(?:[,(\[{]\s*|[A-Za-z0-9_"'`]\s*:\s*|\+=\s*)([a-zA-Z_][a-zA-Z0-9_]{2,})\s*(?=[,)\]}]|$)/g;
    let rm;
    while (lang !== "rust" && (rm = lineRefRe.exec(rawLine)) !== null) {
      const rawRef = rm[1];
      if (
        rawRef !== declName &&
        !localVars.has(rawRef) &&
        !params.includes(rawRef) &&
        !/^(?:true|false|null|None|nil|undefined|self|this|super|err|error|ctx|req|res|int|str|bool|string|number|object|any|void|async|await|const|let|var)$/.test(
          rawRef
        )
      ) {
        const resolvedRef = importAliases[rawRef] || rawRef;
        if (!sites.some((s) => s.line === absLine && s.callee === resolvedRef && !s.isRegistrationRef)) {
          sites.push({
            callee: resolvedRef,
            rawCallee: rawRef,
            receiver: null,
            line: absLine,
            passedArgs: [],
            returnFlow: "REGISTERED_REF",
            inConditionalBranch,
            branchHeaderLine,
            isRegistrationRef: true
          });
        }
      }
    }
  }

  // Fallback for multiline expressions not caught line-by-line
  if (sites.length === 0 && fullJoined.includes("(")) {
    let fm;
    const fallbackRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    while ((fm = fallbackRe.exec(fullJoined)) !== null) {
      if (fm[1] !== declName && !SKIP_CALLEES.test(fm[1])) {
        sites.push({
          callee: importAliases[fm[1]] || fm[1],
          rawCallee: fm[1],
          receiver: null,
          line: startLine,
          passedArgs: [],
          returnFlow: "CONSUMED_EXPR",
          inConditionalBranch: false,
          branchHeaderLine: null,
          isRegistrationRef: false
        });
      }
    }
  }

  return sites;
}

export function parseSourceFile(absPath, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang || !fs.existsSync(absPath)) return null;
  const content = fs.readFileSync(absPath, "utf8");
  return parseSourceFileContent(content, relPath);
}

export function parseSourceFileContent(content, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang || typeof content !== "string") return null;

  const rawLines = content.split(/\r?\n/);
  const sfcInfo = ext === ".vue" || ext === ".svelte" ? preprocessSfcContent(content) : null;
  const lexInput = sfcInfo ? sfcInfo.scriptContent : content;
  let { cleanCode, commentlessCode, lineStartOffsets, parenSpans, braceSpans } = scanTokensAndScopes(
    lexInput,
    sfcInfo ? "ts" : lang
  );
  const rustImports = lang === "rust" ? parseRustImports(cleanCode, braceSpans, commentlessCode) : null;
  const rustMacroTypes = rustImports ? parseRustMacroTypes(cleanCode, rustImports, braceSpans) : null;
  if (rustImports?.macroDefinitions?.length) {
    const maskTemplates = (code) => {
      let end = 0, masked = '';
      for (const definition of rustImports.macroDefinitions) {
        if (definition.startOffset < end) continue;
        masked += code.slice(end, definition.startOffset) +
          code.slice(definition.startOffset, definition.endOffset).replace(/[^\r\n]/g, ' ');
        end = definition.endOffset;
      }
      return masked + code.slice(end);
    };
    cleanCode = maskTemplates(cleanCode);
    commentlessCode = maskTemplates(commentlessCode);
  }
  const cleanLines = cleanCode.split(/\r?\n/);
  const conditionsByLine = conditionalContexts(commentlessCode, lang);

  const fileZone = classifyZone(relPath);
  const { importedStems, importedPaths, reExportedPaths, reExportedStems, importAliases, importBindings, exportBindings } = extractFileImports(
    lang,
    commentlessCode,
    relPath
  );
  const hasJsx = [".jsx", ".tsx", ".js", ".mjs"].includes(ext) && /<[A-Z][A-Za-z0-9_$.]*(?=[\s/>])/.test(cleanCode);
  const jsxBindingLines = hasJsx ? commentlessCode.split(/\r?\n/) : [];
  const fileHasUnityOrHarmony =
    lang === "csharp" && /\b(?:UnityEngine|MonoBehaviour|BaseUnityPlugin|HarmonyLib|HarmonyPatch)\b/.test(content);

  // Detect Vue Options API object brace scopes (`export default { mounted() {}, methods: { submit() {} } }`)
  const vueOptionBraceIndices = new Set();
  if (ext === ".vue") {
    for (let bIdx = 0; bIdx < braceSpans.length; bIdx++) {
      const bs = braceSpans[bIdx];
      const prefix = cleanCode.slice(Math.max(0, bs.openOffset - 60), bs.openOffset);
      if (/\bexport\s+default\s*$|defineComponent\s*\(\s*$/.test(prefix)) {
        vueOptionBraceIndices.add(bIdx);
      }
    }
    if (vueOptionBraceIndices.size > 0) {
      for (let bIdx = 0; bIdx < braceSpans.length; bIdx++) {
        const bs = braceSpans[bIdx];
        if (vueOptionBraceIndices.has(bs.parentIdx)) {
          const prefix = cleanCode.slice(Math.max(0, bs.openOffset - 40), bs.openOffset);
          if (/\b(?:methods|computed|watch)\s*:\s*$/.test(prefix)) {
            vueOptionBraceIndices.add(bIdx);
          }
        }
      }
    }
  }

  // Detect Rust inline `#[cfg(test)]` block ranges so inline unit test modules are marked as `test` zone
  const inlineTestRanges = (rustImports?.modules || [])
    .filter((mod) => mod.inline && rustAttributesZone(mod.attributes) === 'test')
    .map((mod) => ({ startLine: mod.bodyStart, endLine: mod.endLine }));

  const rawDecls = [];
  const containerRanges = []; // { name, startLine, endLine, symbolId, kind }
  const kotlinObjects = new Map();
  if (lang === "kotlin") {
    for (const match of cleanCode.matchAll(/\bobject\s*:\s*[A-Za-z_][A-Za-z0-9_.<>?,\s()]*/g)) {
      const span = braceSpans.find((b) => b.openOffset === match.index + match[0].trimEnd().length ||
        (b.openOffset >= match.index + match[0].length && /^\s*$/.test(cleanCode.slice(match.index + match[0].length, b.openOffset))));
      if (!span) continue;
      const lineIdx = lineStartOffsets.findIndex((start, i) => start <= match.index && (lineStartOffsets[i + 1] ?? Infinity) > match.index);
      const argument = parenSpans.filter((p) => p.openOffset < match.index && p.closeOffset > span.closeOffset)
        .sort((a, b) => b.openOffset - a.openOffset)[0];
      const callee = argument && cleanCode.slice(Math.max(0, argument.openOffset - 100), argument.openOffset).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1];
      const assignment = /\b(?:val|var)\s+[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=\n]+)?=\s*$/.test(cleanCode.slice(lineStartOffsets[lineIdx], match.index));
      kotlinObjects.set(lineIdx, { span, header: cleanCode.slice(match.index, span.openOffset),
        passedTo: !assignment && callee && !/^(?:if|while|when|for|catch)$/.test(callee) ? callee : null });
    }
  }

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
          bs.openLine > (enclosingClass.bodyOpenLine || enclosingClass.startLine) &&
          bs.openLine < currentLine &&
          bs.closeLine >= currentLine
      );
      inClassScope = !deeperBrace;
    }

    let inVueOptionsScope = false;
    if (vueOptionBraceIndices.size > 0 && !inClassScope) {
      let innermostIdx = -1;
      for (let bIdx = 0; bIdx < braceSpans.length; bIdx++) {
        const bs = braceSpans[bIdx];
        if (bs.openLine < currentLine && bs.closeLine >= currentLine) {
          if (innermostIdx === -1 || bs.openOffset > braceSpans[innermostIdx].openOffset) {
            innermostIdx = bIdx;
          }
        }
      }
      if (innermostIdx >= 0 && vueOptionBraceIndices.has(innermostIdx)) {
        inVueOptionsScope = true;
      }
    }

    const declLineText =
      (lang === "ts" || lang === "vue") && /=\s*(?:async\s*)?(?:<[^>]*>\s*)?\([^;]*$/.test(cleanLines[i])
        ? cleanLines.slice(i, Math.min(cleanLines.length, i + 8)).join(" ")
        : cleanLines[i];
    const object = kotlinObjects.get(i);
    const decl = object ? { name: `anonymous@${currentLine}`, kind: "class", isAnonymousObject: true, isPublicApi: false }
      : matchSymbolDeclaration(lang, declLineText, inClassScope, inVueOptionsScope);
    if (!decl) continue;

    const startLine = currentLine;
    let endLine = startLine;
    let paramText = cleanLines[i];
    let bodyStartLineOffset = 1;
    let bounds = null;

    if (object) {
      bounds = { endLine: object.span.closeLine, braceSpan: object.span, hasBraceBody: true, paramSpan: null };
      endLine = bounds.endLine;
    } else if (lang === "python" || lang === "ruby") {
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
        implementationScope: cleanLines.slice(i, bounds.braceSpan ? bounds.braceSpan.openLine : i + 1).join(" ").split("{")[0].replace(/\s+/g, " ").trim(),
        bodyOpenLine: bounds.braceSpan?.openLine,
        isTraitImpl: Boolean(decl.isTraitImpl),
        conditionalContext: conditionsByLine[i]
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

    const parentFunction = rawDecls.findLast((candidate) =>
      (candidate.decl.kind === "function" || candidate.decl.kind === "method") &&
      candidate.startLine < startLine && candidate.endLine >= endLine &&
      (!parentContainer || candidate.startLine > parentContainer.startLine)
    );
    if (parentFunction) {
      parentContainer = null;
      if (decl.kind === "method") decl.kind = "function";
    }
    const conditionalContext = lang === "rust"
      ? [...(parentFunction?.conditionalContext || parentContainer?.conditionalContext || []), ...conditionsByLine[i]]
      : conditionsByLine[i];

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
    if (parentContainer?.isAnonymousObject) decl.isPublicApi = false;

    const containerName = parentContainer ? parentContainer.name : decl.receiverType || null;
    const symId = containerName
      ? `${relPath}::${containerName}.${decl.name}#L${startLine}`
      : `${relPath}::${decl.name}#L${startLine}`;

    if (decl.kind === "class" || decl.kind === "struct") {
      const clsHeaderText = object ? object.header : bounds?.braceSpan
        ? cleanCode.slice(lineStartOffsets[i], bounds.braceSpan.openOffset)
        : cleanLines.slice(i, Math.min(cleanLines.length, i + Math.max(1, bodyStartLineOffset))).join(" ");
      const baseTypes = extractBaseTypes(lang, clsHeaderText);
      const hasBaseOrInterface =
        baseTypes.length > 0 ||
        (lang === "csharp" && /:\s*[A-Za-z_]/.test(clsHeaderText)) ||
        (lang === "java" && /\b(?:extends|implements)\b/.test(clsHeaderText));
      decl.baseTypes = baseTypes;
      containerRanges.push({
        name: decl.name,
        startLine,
        endLine,
        symbolId: symId,
        kind: decl.kind,
        bodyOpenLine: bounds?.braceSpan?.openLine,
        isTrait: Boolean(decl.isTrait),
        isInterface: Boolean(decl.isInterface),
        isAnonymousObject: Boolean(decl.isAnonymousObject),
        baseTypes,
        hasBaseOrInterface,
        conditionalContext
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
      parentFunctionId: parentFunction?.symId || null,
      implementationScope: parentContainer?.implementationScope || null,
      conditionalContext,
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

    const rustAttributes = lang === "rust" ? rustAttributesBefore(cleanCode, commentlessCode,
      lineStartOffsets[i] + (cleanLines[i].search(/\S/) < 0 ? 0 : cleanLines[i].search(/\S/))) : '';
    const rustTestOnly = lang === "rust" &&
      (inlineTestRanges.some((r) => startLine >= r.startLine && endLine <= r.endLine) ||
        rustAttributesZone(rustAttributes) === 'test' || rustAttributeBodies(rustAttributes).some((attribute) => /^(?:tokio::)?test\b/.test(attribute)));
    const symZone = rustTestOnly ? "test" : fileZone;

    const params = decl.kind === "function" || decl.kind === "method" ? extractParamNames(lang, paramText) : [];
    const promotedParams = decl.isConstructor ? extractPromotedParamNames(lang, paramText) : [];
    const refOutParams =
      decl.kind === "function" || decl.kind === "method" ? extractRefOutParamNames(lang, paramText) : [];
    const df = extractDataFlowAndTouches({
      lang,
      decl,
      bounds,
      cleanCode,
      ownCleanLines,
      fullLexicalLines,
      params,
      promotedParams,
      refOutParams,
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
        if (importAliases[callee]) {
          calls.add(importAliases[callee]);
          fileCalls.add(importAliases[callee]);
        }
      }
    }

    for (const bCall of df.bareIgnoredCalls) {
      if (importAliases[bCall.callee]) {
        bCall.callee = importAliases[bCall.callee];
      }
    }

    for (const qc of df.qualifiedCalls) {
      if (!/^(this|self|super|base)$/.test(qc.receiver)) {
        calls.add(qc.member);
        fileCalls.add(qc.member);
        if (
          !qc.isLocal &&
          !params.includes(qc.receiver) &&
          (/^[A-Z]/.test(qc.receiver) || importedStems.includes(qc.receiver) || Boolean(importAliases[qc.receiver]))
        ) {
          calls.add(qc.receiver);
          fileCalls.add(qc.receiver);
          if (importAliases[qc.receiver]) {
            calls.add(importAliases[qc.receiver]);
            fileCalls.add(importAliases[qc.receiver]);
          }
        }
      }
    }

    // First-class callback & handler references passed without `()` (e.g. Go `sub.POST("", backupCreate)`, Python `[_default_ctx]`)
    const cbRefRe = /(?:[,(\[]\s*|:\s*)([a-zA-Z_][a-zA-Z0-9_]{2,})\s*(?=[,)\]}])/g;
    while ((m = cbRefRe.exec(ownCleanBodyText)) !== null) {
      const refName = m[1];
      if (
        refName !== decl.name &&
        !df.localVars.has(refName) &&
        !params.includes(refName) &&
        !/^(?:true|false|null|None|nil|undefined|self|this|super|err|error|ctx|req|res|int|str|bool|string|number|object|any|void)$/.test(
          refName
        )
      ) {
        calls.add(refName);
        fileCalls.add(refName);
        if (importAliases[refName]) {
          calls.add(importAliases[refName]);
          fileCalls.add(importAliases[refName]);
        }
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
    const isFeatureGated = rd.conditionalContext.length > 0 ||
      /#\s*\[\s*allow\s*\(\s*dead_code\b|\bpragma:\s*no\s*cover\b|\/\/\s*reserved\b/im.test(prevLines);
    const isExtensionHook =
      Boolean(decl.isContractMethod) ||
      Boolean(decl.isOverride) ||
      (containerName && /(?:Interface|Base|Scaffold|Adapter|Hook|Handler|Visitor|Listener|Strategy|Policy|Provider|Transport|Loader)$/.test(containerName)) ||
      /\b(?:subclasses?\s+(?:can|may|should)|can\s+be\s+overridden|override\s+this|default\s+implementation|extension\s+point|hook\s+for|intended\s+to\s+be\s+overridden|by\s+default\s+this)\b/i.test(
        rawDocAndHeader
      );

    const callSites =
      decl.kind === "function" || decl.kind === "method"
        ? extractCallSitesForSymbol({
            lang,
            ownCleanLines: lang !== "python" && lang !== "ruby" && bounds?.hasBraceBody ? braceBodyLines(ownCleanLines, bounds, cleanCode, startLine) : ownCleanLines,
            startLine,
            bodyStartLineOffset: lang !== "python" && lang !== "ruby" && bounds?.hasBraceBody ? bounds.braceSpan.openLine - startLine : bodyStartLineOffset,
            declName: decl.name,
            params,
            localVars: df.localVars,
            importAliases,
            isExpressionBody: Boolean(bounds?.isExpressionBody)
          })
        : [];

    if (lang === "rust") for (const site of callSites) {
      calls.add(site.rawCallee);
      fileCalls.add(site.rawCallee);
    }

    const normFinger = decl.kind === "function" || decl.kind === "method" ? normalizeFinger(ownCleanBodyText) : "";
    symbols.push({
      id: symId,
      name: decl.name,
      parentContainerName: containerName,
      parentContainerId,
      parentFunctionId: rd.parentFunctionId,
      implementationScope: rd.implementationScope,
      ...(lang === "rust" ? { rustTestOnly } : {}),
      baseTypes: decl.baseTypes || [],
      kind: decl.kind,
      isInterface: Boolean(decl.isInterface),
      isTrait: Boolean(decl.isTrait),
      isAbstract: /\babstract\b/.test(cleanLines[i]) || /@(?:abc\.)?abstractmethod\b/.test(prevLines),
      hasImplementation: Boolean(bounds?.hasBraceBody || bounds?.isExpressionBody || ((lang === "python" || lang === "ruby") && endLine > startLine)),
      callablePropertyNames: (decl.kind === "class" || decl.kind === "struct") && (lang === "ts" || lang === "vue")
        ? Array.from(ownCleanBodyText.matchAll(/^\s*(?:(?:public|readonly|override|declare)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*typeof\s+[A-Za-z_$][^\n=]*=\s*[A-Za-z_$][A-Za-z0-9_$]*(?:\s*;?\s*)$/gm), (m) => m[1])
        : [],
      isPublicApi: Boolean(decl.isPublicApi),
      isAnonymousObject: Boolean(decl.isAnonymousObject),
      anonymousObjectPassedTo: kotlinObjects.get(i)?.passedTo || null,
      isConstructor: Boolean(decl.isConstructor),
      isExtensionHook,
      isFeatureGated,
      conditionalContext: rd.conditionalContext,
      file: relPath,
      lang,
      zone: symZone,
      startLine,
      endLine,
      isEntrySource,
      roles: isEntrySource ? ["source"] : [],
      isTauriCommand: lang === "rust" && /#\[(?:tauri::)?command(?:\s*\([^)]*\))?\s*\]|#\[specta::specta\b/.test(prevLines),
      paired: detectPairedKind(decl.name),
      params,
      parameterSlots: extractParamNames(lang, paramText, true),
      readParams: df.readParams,
      parameterFieldReads: df.parameterFieldReads,
      localVars: Array.from(df.localVars),
      unusedParams: df.unusedParams,
      reservedParams: [],
      hasReturnValue: df.hasReturnValue,
      canIgnoreReturnValue: df.canIgnoreReturnValue,
      hasInternalMutation: df.hasInternalMutation,
      bareIgnoredCalls: df.bareIgnoredCalls,
      deadLocalVars: df.deadLocalVars,
      conditionalCount: df.conditionalCount,
      qualifiedCalls: df.qualifiedCalls,
      callSites,
      jsxReferences: hasJsx ? extractJsxReferences(ownCleanLines.join("\n"), startLine) : [],
      jsxLocalBindings: hasJsx ? extractJsxLocalBindings(ownCleanLines.map((line, offset) => line ? jsxBindingLines[i + offset] : "").join("\n")) : [],
      upperConstantsRead: df.upperConstantsRead || [],
      calls: Array.from(calls),
      writes: df.writes,
      delegatedWrites: df.delegatedWrites,
      reads: df.reads,
      ownCleanBodyText,
      snippet: rawLines.slice(Math.max(0, i - 1), Math.min(rawLines.length, i + 14)).join("\n"),
      shingles: buildShingleSet(normFinger)
    });
  }

  // Ruby `attr_reader` / `attr_accessor` / `attr_writer` expose `@ivar` state reads/writes on enclosing class
  if (lang === "ruby" && symbols.length > 0) {
    for (let lnIdx = 0; lnIdx < cleanLines.length; lnIdx++) {
      const attrM = cleanLines[lnIdx].match(/^\s*attr_(reader|writer|accessor)\b([^\n;#]+)/);
      if (!attrM) continue;
      const mode = attrM[1];
      const line1 = lnIdx + 1;
      const enc = containerRanges.filter((c) => line1 >= c.startLine && line1 <= c.endLine).pop();
      const targetSym =
        (enc && symbols.find((s) => s.id === enc.symbolId)) ||
        symbols.find((s) => s.parentContainerName === enc?.name) ||
        symbols[0];
      if (!targetSym) continue;
      let symM;
      const symTokRe = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
      while ((symM = symTokRe.exec(attrM[2])) !== null) {
        const fld = symM[1];
        if (fld.length > 1) {
          if ((mode === "reader" || mode === "accessor") && !targetSym.reads.includes(fld)) {
            targetSym.reads.push(fld);
          }
          if ((mode === "writer" || mode === "accessor") && !targetSym.writes.includes(fld)) {
            targetSym.writes.push(fld);
          }
        }
      }
    }
  }

  // Reconcile member field reads across the same file (`this.field = x` in constructor/setter, bare `field` or `obj.field` read in methods)
  const fileWrittenFields = new Set();
  for (const s of symbols) {
    for (const w of s.writes) fileWrittenFields.add(w);
  }
  if (fileWrittenFields.size > 0) {
    const topLevelNonContainerLines = cleanLines.map((ln, idx) => {
      const line1 = idx + 1;
      const inContainer = containerRanges.some((c) => line1 > c.startLine && line1 < c.endLine);
      return inContainer ? "" : ln;
    });
    const topLevelCleanText = topLevelNonContainerLines.join("\n");

    for (const field of fileWrittenFields) {
      const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const leftBound = field.startsWith("#") ? "(?<![A-Za-z0-9_])" : "\\b";
      const anyReadRe = new RegExp(`${leftBound}${esc}\\b(?!\\s*=(?!=))`);
      let matchedInSymbol = false;
      for (const s of symbols) {
        if (s.reads.includes(field)) {
          matchedInSymbol = true;
          continue;
        }
        if (s.kind !== "function" && s.kind !== "method") continue;
        if (anyReadRe.test(s.ownCleanBodyText || "")) {
          const withoutWriteLhs = (s.ownCleanBodyText || "").replace(
            new RegExp(`\\b(?:this|self|state|store)(?:\\.#?[a-zA-Z_][a-zA-Z0-9_]*)?\\.${esc}\\s*=(?!=)(?:\\s*${esc}\\b)?`, "g"),
            ""
          );
          if (anyReadRe.test(withoutWriteLhs)) {
            s.reads.push(field);
            matchedInSymbol = true;
          }
        }
      }
      if (!matchedInSymbol && symbols.length > 0) {
        if (sfcInfo && sfcInfo.sfcTemplateIdents.has(field)) {
          const hostSym = symbols.find((s) => s.isEntrySource) || symbols[0];
          if (!hostSym.reads.includes(field)) hostSym.reads.push(field);
        } else if (!field.startsWith("#")) {
          const fileWithoutWriteLhs = topLevelCleanText.replace(
            new RegExp(`\\b(?:this|self|state|store)(?:\\.#?[a-zA-Z_][a-zA-Z0-9_]*)?\\.${esc}\\s*=(?!=)(?:\\s*${esc}\\b)?`, "g"),
            ""
          );
          if (anyReadRe.test(fileWithoutWriteLhs)) {
            const hostSym = symbols.find((s) => !s.parentContainerName && s.isEntrySource) || symbols.find((s) => !s.parentContainerName) || symbols[0];
            if (!hostSym.reads.includes(field)) hostSym.reads.push(field);
          }
        }
      }
    }
  }
  for (const s of symbols) delete s.ownCleanBodyText;

  // Track explicitly private container fields (`#field` or `private field`) and file-wide `.prop` member reads
  const privateFieldsByContainer = Object.create(null);
  for (const c of containerRanges) {
    if (!c.name) continue;
    const privSet = new Set(privateFieldsByContainer[c.name] || []);
    const cSlice = cleanLines.slice(Math.max(0, c.startLine - 1), Math.min(cleanLines.length, c.endLine)).join("\n");
    const privDeclRe =
      /\bprivate\s+(?:(?:readonly|static|final|const|var|let|mut)\s+)*(?:[A-Za-z0-9_<>\[\]?|&\\:]+\s+)?\$?([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:;,)]|(?<![A-Za-z0-9_])(#[a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*\()/g;
    let pm;
    while ((pm = privDeclRe.exec(cSlice)) !== null) {
      const fName = pm[1] || pm[2];
      if (fName && fName.length > 1) privSet.add(fName);
    }
    if (privSet.size > 0) privateFieldsByContainer[c.name] = Array.from(privSet);
  }
  for (const s of symbols) {
    if (s.parentContainerName) {
      for (const w of s.writes) {
        if (w.startsWith("#")) {
          if (!privateFieldsByContainer[s.parentContainerName]) privateFieldsByContainer[s.parentContainerName] = [];
          if (!privateFieldsByContainer[s.parentContainerName].includes(w)) {
            privateFieldsByContainer[s.parentContainerName].push(w);
          }
        }
      }
    }
  }

  const memberReadsSet = new Set(sfcInfo ? sfcInfo.sfcMemberReads : []);
  const cleanWithoutAssignLhs = cleanCode.replace(/\.[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/g, " =");
  const extPropReadRe = /(?:\??\.|->)([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*\()/g;
  let mr;
  while ((mr = extPropReadRe.exec(cleanWithoutAssignLhs)) !== null) {
    if (mr[1].length > 1) memberReadsSet.add(mr[1]);
  }

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

  // Render expressions (`{{ fmt(x) }}`, bindings) are same-file references.
  // Vue event directives are handled separately as runtime-conditional
  // registrations below, so they must not promote the handler to a library
  // surface or a confirmed direct call.
  if (sfcInfo) {
    for (const s of symbols) {
      if (sfcInfo.sfcTemplateIdents.has(s.name)) {
        s.isReferencedInFile = true;
      }
    }
  }

  // Same-file first-class callback / table registration / Rust serde / C# reflection binding detection
  const hasReflectedDeclaredMethods =
    lang === "csharp" && /\b(?:DeclaredMethods|GetMethods)\b/.test(cleanCode);
  const referenceCode = (lang === "rust" ? rawLines : cleanLines).join("\n")
    .replace(/\bexport\s*(?:type\s*)?\{[^}]*\}/g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/\bexport\s+default\s+[A-Za-z_$][A-Za-z0-9_$]*\s*;?/g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/\bmodule\.exports\s*=\s*\{[^}]*\}/g, (s) => s.replace(/[^\n]/g, " "));
  const referenceOffsets = [0];
  for (let index = 0; index < referenceCode.length; index++) if (referenceCode[index] === "\n") referenceOffsets.push(index + 1);
  const referenceNames = new Set(symbols.filter((s) => s.kind === "function" || s.kind === "method").map((s) => s.name));
  const indexReferences = (code) => {
    const index = new Map();
    const tokens = /(?<![A-Za-z0-9_$])#?[A-Za-z_$][A-Za-z0-9_$]*/g;
    for (const token of code.matchAll(tokens)) {
      const names = [token[0]];
      if (token[0].startsWith("#") || (["php", "kotlin", "dart"].includes(lang) && token[0].startsWith("$"))) names.push(token[0].slice(1));
      for (const name of names) if (referenceNames.has(name)) {
        if (!index.has(name)) index.set(name, []);
        index.get(name).push(token.index);
      }
    }
    return index;
  };
  const fileReferenceIndex = indexReferences(referenceCode);
  const otherSymbolReferences = new Map(symbols.map((s) => [s.id, indexReferences(cleanLines.slice(s.startLine - 1, s.endLine).join("\n"))]));
  const callbackReferenceIndex = new Map();
  const callbackReferencePattern = /(?:\+=\s*([A-Za-z_$][A-Za-z0-9_$]*)\b(?!\s*\()|\b(?!const\b|let\b|var\b|auto\b|export\b|return\b)[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)\s*(?:new\s+[A-Za-z0-9_.<>]+\s*\(\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\b(?!\s*\()|[,(\[]\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,)\]}]))/g;
  for (const match of referenceCode.matchAll(callbackReferencePattern)) {
    const name = match[1] || match[2] || match[3];
    if (!referenceNames.has(name)) continue;
    if (!callbackReferenceIndex.has(name)) callbackReferenceIndex.set(name, []);
    callbackReferenceIndex.get(name).push(match.index + match[0].lastIndexOf(name));
  }
  for (const s of symbols) {
    if (s.kind !== "function" && s.kind !== "method") continue;
    if (hasReflectedDeclaredMethods && s.parentContainerName && cleanCode.includes(`typeof(${s.parentContainerName})`)) {
      s.isReferencedInFile = true;
      continue;
    }
    const beforeOffset = referenceOffsets[s.startLine - 1];
    const afterOffset = referenceOffsets[s.endLine] ?? referenceCode.length;
    const isOutside = (offset) => offset < beforeOffset || offset >= afterOffset;
    if ((fileReferenceIndex.get(s.name) || []).some(isOutside)) {
      s.isReferencedInFile = true;
      if ((callbackReferenceIndex.get(s.name) || []).some(isOutside)) {
        s.isCallbackRef = true;
      }
      for (const other of symbols) {
        if (other.id !== s.id && (s.startLine < other.startLine || s.endLine > other.endLine)) {
          if (otherSymbolReferences.get(other.id).has(s.name)) {
            if (!other.calls.includes(s.name)) other.calls.push(s.name);
            if (
              other.callSites &&
              !other.callSites.some((cs) => cs.callee === s.name)
            ) {
              other.callSites.push({
                callee: s.name,
                rawCallee: s.name,
                receiver: null,
                line: other.startLine,
                passedArgs: [],
                returnFlow: "REGISTERED_REF",
                inConditionalBranch: false,
                branchHeaderLine: null,
                isRegistrationRef: true
              });
            }
          }
        }
      }
    }
    if (lang === "csharp" && s.params[0] === "sender" && s.params.length >= 2) {
      s.isCallbackRef = true;
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

  // Cross-boundary signals (with 1-based line numbers & payload field keys for exact attribution)
  const bridgeSignals = {
    tauriInvokes: [],
    rpcCalls: [],
    eventTouches: [],
    electronSends: [],
    electronHandles: [],
    httpCalls: [],
    httpRoutes: [],
    configTouches: [],
    webview2Touches: [],
    sharedMemoryTouches: []
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

  const msgEmitRe =
    /\bsend\s*\(\s*["']([a-zA-Z][a-zA-Z0-9_.-]{2,})["']|(?:[{,[(\s]|^)(?<!\?\s*)["'](?:cmd|method)["']\s*:\s*["']([a-zA-Z][a-zA-Z0-9_.-]{2,})["']/g;
  while ((m = msgEmitRe.exec(commentStripped)) !== null) {
    const cmdTopic = `cmd:${m[1] || m[2]}`;
    addUnique(bridgeSignals.eventTouches, `EVT:${cmdTopic}:emit`, {
      topic: cmdTopic,
      mode: "emit",
      line: offsetToLine(m.index)
    });
  }
  const msgListenRe = /\b(?:cmd|method)\s*===?\s*["']([a-zA-Z][a-zA-Z0-9_.-]{2,})["']/g;
  while ((m = msgListenRe.exec(commentStripped)) !== null) {
    const cmdTopic = `cmd:${m[1]}`;
    addUnique(bridgeSignals.eventTouches, `EVT:${cmdTopic}:listen`, {
      topic: cmdTopic,
      mode: "listen",
      line: offsetToLine(m.index)
    });
  }

  // Socket.io / WebSocket / App EventBus (`socket/io/eventBus/bus/emitter/app/window.emit("evt")` <-> `.on/.listen("evt")`)
  const sockEmitRe =
    /\b(?:this\.)?\$?(?:socket|io|eventBus|bus|emitter|events|app|window)\.(?:volatile\.)?emit\s*\(\s*["']([a-zA-Z][a-zA-Z0-9_.:/-]{1,})["']/g;
  while ((m = sockEmitRe.exec(commentStripped)) !== null) {
    if (!/^(?:connect|disconnect|disconnecting|error|connection|reconnect|ping|pong|data|end|close)$/i.test(m[1])) {
      const wsTopic = m[1].includes(":") || m[1].includes("/") ? `ws:${m[1]}` : `evt:${m[1]}`;
      addUnique(bridgeSignals.eventTouches, `EVT:${wsTopic}:emit`, {
        topic: wsTopic,
        mode: "emit",
        line: offsetToLine(m.index)
      });
    }
  }
  const sockOnRe =
    /\b(?:this\.)?\$?(?:socket|io|eventBus|bus|emitter|events|app|window)\.(?:on|once|listen)\s*\(\s*["']([a-zA-Z][a-zA-Z0-9_.:/-]{1,})["']/g;
  while ((m = sockOnRe.exec(commentStripped)) !== null) {
    if (!/^(?:connect|disconnect|disconnecting|error|connection|reconnect|ping|pong|data|end|close|message)$/i.test(m[1])) {
      const wsTopic = m[1].includes(":") || m[1].includes("/") ? `ws:${m[1]}` : `evt:${m[1]}`;
      addUnique(bridgeSignals.eventTouches, `EVT:${wsTopic}:listen`, {
        topic: wsTopic,
        mode: "listen",
        line: offsetToLine(m.index)
      });
    }
  }

  if (lang === "ts" || lang === "vue") {
    if (!/\b(?:function\s+invoke|(?:const|let|var)\s+invoke\s*=)\b/.test(cleanCode)) {
      const invRe = /\b(?:__TAURI_INVOKE|TAURI_INVOKE|invoke)\s*(?:<[^>]*>)?\s*\(\s*["']([a-z_][a-z0-9_]+)["']/g;
      while ((m = invRe.exec(commentStripped)) !== null) {
        addUnique(bridgeSignals.tauriInvokes, `TAURI:${m[1]}`, {
          cmd: m[1],
          line: offsetToLine(m.index),
          payloadFields: extractCallPayloadFields(commentStripped, m.index)
        });
      }
    }
    const rpcRe = /\b([a-zA-Z0-9_$]+(?:ServiceClient|AuthClient|RpcClient))\.([a-z][a-zA-Z0-9_]*)\s*\(/g;
    while ((m = rpcRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.rpcCalls, `RPC:${m[1]}.${m[2]}`, {
        client: m[1],
        method: m[2],
        line: offsetToLine(m.index),
        payloadFields: extractCallPayloadFields(commentStripped, m.index)
      });
    }
    const elSendRe = /\bipcRenderer\.(?:invoke|send)\s*\(\s*["']([^"']+)["']/g;
    while ((m = elSendRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.electronSends, `ELSEND:${m[1]}`, {
        channel: m[1],
        line: offsetToLine(m.index),
        payloadFields: extractCallPayloadFields(commentStripped, m.index)
      });
    }
    const elHandleRe = /\bipcMain\.(?:handle|on)\s*\(\s*["']([^"']+)["']/g;
    while ((m = elHandleRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.electronHandles, `ELHND:${m[1]}`, { channel: m[1], line: offsetToLine(m.index) });
    }
    const wv2SendRe = /\bchrome\.webview\.postMessage\s*\(/g;
    while ((m = wv2SendRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.webview2Touches, `WV2:js:send:${offsetToLine(m.index)}`, {
        side: "frontend",
        mode: "send",
        line: offsetToLine(m.index),
        payloadFields: extractCallPayloadFields(commentStripped, m.index)
      });
    }
    const wv2ListenRe = /\bchrome\.webview\.addEventListener\s*\(\s*["']message["']/g;
    while ((m = wv2ListenRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.webview2Touches, `WV2:js:listen:${offsetToLine(m.index)}`, {
        side: "frontend",
        mode: "listen",
        line: offsetToLine(m.index),
        payloadFields: []
      });
    }
    const httpRe =
      /\b(?:(fetch)|(?:axios|http|ky|api)\.(get|post|put|delete|patch))\s*(?:<[^>]*>)?\s*\(\s*["'`]((?:\$\{[A-Za-z0-9_$.()?:-]+\})?\/[a-zA-Z][a-zA-Z0-9_/${}.:-]*|api\/[a-zA-Z0-9_/${}.:-]*|[a-z][a-z0-9_-]{2,})["'`]/g;
    while ((m = httpRe.exec(commentStripped)) !== null) {
      const rawMatched = m[3];
      const rawPath = rawMatched.replace(/^\$\{[^}]+\}(?=\/)/, "");
      // Bare fetch("foo") without leading `/` is skipped unless called via explicit HTTP client wrapper (`axios/http/ky/api.*`)
      if (m[1] && !rawPath.startsWith("/")) continue;
      let method = m[2] ? m[2].toUpperCase() : "GET";
      if (m[1]) {
        const openParenIdx = commentStripped.indexOf("(", m.index);
        let closeParenIdx = Math.min(commentStripped.length, m.index + m[0].length + 240);
        if (openParenIdx >= 0) {
          let depth = 0;
          for (let k = openParenIdx; k < closeParenIdx; k++) {
            if (commentStripped[k] === "(") depth++;
            else if (commentStripped[k] === ")") {
              depth--;
              if (depth === 0) {
                closeParenIdx = k;
                break;
              }
            }
          }
        }
        const optsSlice = commentStripped.slice(m.index + m[0].length, closeParenIdx);
        const methodM = optsSlice.match(/\bmethod\s*:\s*["']([A-Za-z]+)["']/);
        if (methodM) method = methodM[1].toUpperCase();
      }
      const apiPath = rawPath.startsWith("/") ? rawPath : `/api/${rawPath}`;
      addUnique(bridgeSignals.httpCalls, `HTTPCALL:${method}:${apiPath}`, {
        method,
        path: apiPath,
        line: offsetToLine(m.index),
        payloadFields: extractCallPayloadFields(commentStripped, m.index)
      });
    }
    const openApiSdkRe =
      /(?:\b(?:client|request)|\))\.(get|post|put|delete|patch)\s*(?:<[^>{]{0,220}>)?\s*\(\s*\{[^{}]{0,240}?\burl\s*:\s*["'`](\/[^"'`?\s]+)["'`]/g;
    while ((m = openApiSdkRe.exec(commentStripped)) !== null) {
      const method = m[1].toUpperCase();
      const apiPath = m[2];
      addUnique(bridgeSignals.httpCalls, `HTTPCALL:${method}:${apiPath}`, {
        method,
        path: apiPath,
        line: offsetToLine(m.index),
        payloadFields: extractCallPayloadFields(commentStripped, m.index)
      });
    }
  }

  // Native C++/C#/Rust WebView2 & Win32/POSIX/Python Shared Memory IPC probes
  if (lang === "cpp" || lang === "csharp" || lang === "rust") {
    const wv2NatSendRe = /\bPostWebMessageAs(?:Json|String)\s*\(/g;
    while ((m = wv2NatSendRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.webview2Touches, `WV2:nat:send:${offsetToLine(m.index)}`, {
        side: "native",
        mode: "send",
        line: offsetToLine(m.index),
        payloadFields: []
      });
    }
    const wv2NatListenRe = /\b(?:add_WebMessageReceived|WebMessageReceived\s*\+=)/g;
    while ((m = wv2NatListenRe.exec(commentStripped)) !== null) {
      addUnique(bridgeSignals.webview2Touches, `WV2:nat:listen:${offsetToLine(m.index)}`, {
        side: "native",
        mode: "listen",
        line: offsetToLine(m.index),
        payloadFields: []
      });
    }
  }
  const shmWinRe = /\b(CreateFileMapping|OpenFileMapping)[AW]?\s*\([^;()]{0,180}?L?["']([A-Za-z0-9_./\\:-]{3,})["']/g;
  while ((m = shmWinRe.exec(commentStripped)) !== null) {
    const mode = m[1].startsWith("Create") ? "write" : "read";
    addUnique(bridgeSignals.sharedMemoryTouches, `SHM:${m[2]}:${mode}`, {
      segment: m[2],
      mode,
      line: offsetToLine(m.index)
    });
  }
  const shmPosixRe = /\bshm_open\s*\(\s*["'](\/?[A-Za-z0-9_.-]{3,})["']\s*,([^)]+)\)/g;
  while ((m = shmPosixRe.exec(commentStripped)) !== null) {
    const mode = /\bO_CREAT\b|\bO_RDWR\b/.test(m[2]) ? "write" : "read";
    addUnique(bridgeSignals.sharedMemoryTouches, `SHM:${m[1]}:${mode}`, {
      segment: m[1],
      mode,
      line: offsetToLine(m.index)
    });
  }
  if (lang === "python") {
    const pyShmRe = /\bSharedMemory\s*\(([^)]*)\)/g;
    while ((m = pyShmRe.exec(commentStripped)) !== null) {
      const nameM = m[1].match(/\bname\s*=\s*r?["']([A-Za-z0-9_./\\:-]{3,})["']|^\s*r?["']([A-Za-z0-9_./\\:-]{3,})["']/);
      if (nameM) {
        const seg = nameM[1] || nameM[2];
        const mode = /\bcreate\s*=\s*True\b/.test(m[1]) ? "write" : "read";
        addUnique(bridgeSignals.sharedMemoryTouches, `SHM:${seg}:${mode}`, {
          segment: seg,
          mode,
          line: offsetToLine(m.index)
        });
      }
    }
  }

  const filePrefixM =
    commentStripped.match(/\bAPIRouter\s*\([^)]*\bprefix\s*=\s*["'](\/[^"']+)["']/) ||
    commentStripped.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["'](\/[^"']+)["']/);
  const fileRoutePrefix = filePrefixM ? filePrefixM[1].replace(/\/+$/, "") : "";
  const isApiRoutesFile = /(?:^|\/)routes\/api[^/]*\.php$/i.test(relPath.replace(/\\/g, "/"));

  const routeRe =
    /(#\[(?:get|post|put|delete|patch|Route)|@(?:app|router|bp|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)(?:\.(?:get|post|put|delete|patch|route))?|\[Http(?:Get|HttpPost|Put|Delete|Patch|Post)|\bRoute::(?:get|post|put|delete|patch)|\b(?:app|router|mux|r|e|sub|rg|svr|server|http\w*|ctx_http)(?:\.|->)(?:get|post|put|delete|patch|Get|Post|Put|Delete|Patch|GET|POST|PUT|DELETE|PATCH|HandleFunc))\s*\(\s*["']([^"']*)["']/g;
  while ((m = routeRe.exec(commentStripped)) !== null) {
    const rawHead = m[1];
    const rawRtPath = m[2];
    const isLaravelRoute = rawHead.startsWith("Route::");
    if (!rawRtPath && !fileRoutePrefix) continue;
    if (!rawRtPath.startsWith("/") && !isLaravelRoute && !fileRoutePrefix) continue;
    let rtPath = rawRtPath.startsWith("/") ? rawRtPath : `/${rawRtPath}`;
    if (fileRoutePrefix && !rtPath.startsWith(fileRoutePrefix)) {
      rtPath = `${fileRoutePrefix}${rtPath === "/" ? "" : rtPath}`;
    } else if (isLaravelRoute && isApiRoutesFile && !rtPath.startsWith("/api/")) {
      rtPath = `/api${rtPath}`;
    }
    let method = "ANY";
    if (/(?:get|GetMapping|HttpGet)\b/i.test(rawHead) && !/RequestMapping|Route$|route$|HandleFunc$/.test(rawHead)) {
      method = "GET";
    } else if (/(?:post|PostMapping|HttpPost)\b/i.test(rawHead)) {
      method = "POST";
    } else if (/(?:put|PutMapping|HttpPut)\b/i.test(rawHead)) {
      method = "PUT";
    } else if (/(?:delete|DeleteMapping|HttpDelete)\b/i.test(rawHead)) {
      method = "DELETE";
    } else if (/(?:patch|PatchMapping|HttpPatch)\b/i.test(rawHead)) {
      method = "PATCH";
    } else {
      const tailCtx = commentStripped
        .slice(m.index, Math.min(commentStripped.length, m.index + 200))
        .split(/\)\s*(?:\r?\n|\{|;)/)[0];
      const explicitM = tailCtx.match(/\bmethods?\s*=\s*\[?\s*["']([A-Za-z]+)["']|RequestMethod\.([A-Z]+)/i);
      if (explicitM) method = (explicitM[1] || explicitM[2]).toUpperCase();
    }
    addUnique(bridgeSignals.httpRoutes, `HTTPROUTE:${method}:${rtPath}`, {
      method,
      path: rtPath,
      line: offsetToLine(m.index)
    });
  }
  if (lang === "ruby") {
    const sinatraRe = /^\s*(get|post|put|delete|patch)\s+["'](\/[^"']+)["']\s+do\b/gm;
    while ((m = sinatraRe.exec(commentStripped)) !== null) {
      const method = m[1].toUpperCase();
      const rtPath = m[2];
      addUnique(bridgeSignals.httpRoutes, `HTTPROUTE:${method}:${rtPath}`, {
        method,
        path: rtPath,
        line: offsetToLine(m.index)
      });
    }
  }

  // Retain actual top-level calls as well as rendering when modules also declare
  // helpers. Benchmark/tool scripts are consumers, even outside production code.
  const hasJsModule = lang === "ts" || lang === "vue";
  const moduleLines = (hasJsx || hasJsModule) && symbols.length > 0 ? cleanLines.map((line, index) =>
    symbols.some((s) => index + 1 >= s.startLine && index + 1 <= s.endLine) ? "" : line) : cleanLines;
  const moduleCode = moduleLines.join("\n");
  const moduleJsx = hasJsx ? extractJsxReferences(moduleCode) : [];
  const moduleSites = hasJsModule ? extractCallSitesForSymbol({ lang, ownCleanLines: moduleLines, startLine: 1,
    bodyStartLineOffset: 0, declName: "", params: [], localVars: new Set(), importAliases, isExpressionBody: false }) : [];
  if (symbols.length === 0 || moduleJsx.length > 0 || moduleSites.some((site) => !site.isRegistrationRef) ||
      sfcInfo?.sfcTemplateEventHandlers.length > 0) {
    const baseName = path.basename(relPath, ext);
    const df = extractDataFlowAndTouches({
      lang,
      decl: { name: baseName, kind: "module" },
      bounds: null,
      cleanCode: moduleCode,
      ownCleanLines: moduleLines,
      params: [],
      bodyStartLineOffset: 1,
      prevLines: content.slice(0, 300)
    });
    const isEntrySource = isRuntimeEntrySource(
      lang,
      relPath,
      baseName,
      content.slice(0, 300),
      moduleCode,
      fileHasUnityOrHarmony
    );
    const calls = new Set();
    const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    while ((m = callRe.exec(moduleCode)) !== null) {
      if (m[1].length >= 2) calls.add(m[1]);
    }
    symbols.push({
      id: `${relPath}::${baseName}${symbols.length ? "#module" : ""}#L1`,
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
      callSites: moduleSites,
      jsxReferences: moduleJsx,
      jsxLocalBindings: hasJsx ? extractJsxLocalBindings(moduleLines.map((line, offset) => line ? jsxBindingLines[offset] : "").join("\n")) : [],
      upperConstantsRead: df.upperConstantsRead || [],
      calls: Array.from(calls),
      writes: df.writes,
      delegatedWrites: df.delegatedWrites,
      reads: df.reads,
      snippet: rawLines.slice(0, 15).join("\n"),
      shingles: new Set()
    });
  }

  const rustReceiverFacts = lang === 'rust' ? parseRustReceiverFacts(cleanCode, braceSpans, symbols) : null;
  if (rustReceiverFacts) for (const symbol of symbols) {
    for (const continuation of rustReceiverFacts.get(symbol.id)?.chainContinuations || []) {
      if (symbol.callSites.some(site => site.line === continuation.line && site.rawCallee === continuation.name)) continue;
      symbol.calls = [...new Set([...symbol.calls, continuation.name])];
      symbol.callSites.push({ callee: continuation.name, rawCallee: continuation.name, receiver: null,
        line: continuation.line, passedArgs: [], positionalArgs: null, argumentMapping: 'UNRESOLVED',
        returnFlow: 'CONSUMED_EXPR', isRegistrationRef: false });
    }
  }
  return {
    contentHash: crypto.createHash("sha256").update(content).digest("hex"),
    packageName: ["go", "java", "kotlin"].includes(lang) ? cleanCode.match(/^\s*package\s+([\w.]+)/m)?.[1] || null : null,
    file: relPath,
    lang,
    zone: fileZone,
    importedStems,
    importedPaths,
    reExportedPaths,
    reExportedStems,
    importBindings,
    exportBindings,
    frameworkCallbackFacts: parseFrameworkCallbackFacts(cleanCode, commentlessCode, symbols, importBindings, lang, relPath),
    templateEventHandlers: sfcInfo?.sfcTemplateEventHandlers || [],
    ...(lang === "rust" ? { rustImports } : {}),
    ...(lang === "rust" ? { rustReceiverFacts } : {}),
    ...(lang === 'rust' ? { rustTypeFlow: parseRustTypeFlow(cleanCode, braceSpans, parenSpans, symbols) } : {}),
    ...(lang === 'rust' ? { rustMacroTypes } : {}),
    ...(lang === "python" ? { pythonDependencies: parsePythonDependencies(cleanCode, symbols) } : {}),
    isAlembicRevision: lang === "python" && /^\s*(?:from\s+alembic\s+import|import\s+alembic\b)/m.test(cleanCode) &&
      /^revision\s*(?::[^=\n]+)?=/m.test(cleanCode) && /^down_revision\s*(?::[^=\n]+)?=/m.test(cleanCode),
    defaultExportName: lang === "ts" ? commentlessCode.match(/\bexport\s+default\s+(?:(?:async\s+)?function\s+|class\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\b/)?.[1] || null : null,
    privateFieldsByContainer,
    memberReads: Array.from(memberReadsSet),
    symbols,
    fileCalls: Array.from(fileCalls),
    bridgeSignals
  };
}
