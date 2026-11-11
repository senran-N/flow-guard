const SYMMETRIC_PAIRS = [
  {
    left: /^(?:Save|Write|Serialize|Encode|Pack|Export)(?:[A-Z_]|$)/,
    right: /^(?:Load|Read|Deserialize|Decode|Unpack|Import)(?:[A-Z_]|$)/,
    label: "Save/Load (持久化/序列化对称)"
  },
  {
    left: /^(?:Send|Broadcast|Emit|Publish)(?:[A-Z_]|$)/,
    right: /^(?:Receive|OnMessage|Consume|Poll)(?:[A-Z_]|$)/,
    label: "Send/Receive (网络/事件收发对称)"
  },
  {
    left: /^(?:Register|Subscribe|Bind|Attach)(?:[A-Z_]|$)/,
    right: /^(?:Unregister|Unsubscribe|Unbind|Detach)(?:[A-Z_]|$)/,
    label: "Register/Unregister (生命周期注册/注销对称)"
  },
  {
    left: /^(?:Start|Open|Connect|Enable)(?:[A-Z_]|$)/,
    right: /^(?:Stop|Close|Disconnect|Disable)(?:[A-Z_]|$)/,
    label: "Start/Stop (启停与连接生命周期对称)"
  },
  {
    left: /^(?:Acquire|Lock|Enter)(?:[A-Z_]|$)/,
    right: /^(?:Release|Unlock|Leave)(?:[A-Z_]|$)/,
    label: "Acquire/Release (资源获取/释放对称)"
  }
];

const KEYWORDS_RE =
  /^(if|else|for|foreach|while|switch|case|return|break|continue|new|await|async|fn|let|mut|pub|match|try|catch|throw|null|true|false|void|int|string|bool|def|class|func|package|import|from)$/;

export function classifyZone(relPath) {
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  if (
    /(^|\/)(tests?|__tests__|test[-_]?dts|specs?|testing|testdata|fixtures?|protocol\.tests|fuzz|mocks?|__mocks__|mockwebserver(?:[-_][a-z0-9_-]+)?|[^/]+[-_]testing[-_]support|test[-_]?helpers?|test[-_]?utils?|test[-_]?support|(?:common|jvm|js|native|apple|ios|macos|linux|mingw|wasm[a-z0-9]*|android(?:host|instrumented|unit)?|desktop)tests?)(\/|$)/.test(
      norm
    ) ||
    /\.(test|test-d|spec|bench|d)\.[a-z0-9]+$/.test(norm) ||
    /(\.pb\.go|\.pb\.gw\.go|\.connect\.go|_pb\.ts|_connect\.ts|\.g\.cs|\.generated\.cs|\.g\.dart|\.freezed\.dart|_tests?\.rs|tests?\.cs|_test\.go|(^|\/)test_[^/]+\.(py|go)|_test\.py|tests?\.java|tests?\.kt|tests?\.swift|_test\.dart|_spec\.rb)$/.test(
      norm
    )
  ) {
    return "test";
  }
  if (
    /(^|\/)(scratch|lab|experiments?|evals?|evaluations?|examples?(?:[-_][a-z0-9_-]+)?|samples?(?:[-_][a-z0-9_-]+)?|playground|tmp|sandbox|docs(?:[-_][a-z0-9_-]+)?|documentation|website|benchmarks?|benches|bench|metrics|scripts\/profile|public\/libs?|\.configs?)(\/|$)/.test(
      norm
    ) ||
    /(^|\/)eval[-_][^/]+\.[a-z0-9]+$|\.eval\.[a-z0-9]+$/.test(norm)
  ) {
    return "sandbox";
  }
  return "prod";
}

export function detectPairedKind(name) {
  for (const p of SYMMETRIC_PAIRS) {
    if (p.left.test(name)) return { group: p.label, side: "left" };
    if (p.right.test(name)) return { group: p.label, side: "right" };
  }
  return null;
}

export function normalizeFinger(code) {
  return code
    .replace(/\/\/.*$/gm, "")
    .replace(/#.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/["'`].*?["'`]/g, '"S"')
    .replace(/\b[a-z_][a-zA-Z0-9_]*\b/g, (w) => (KEYWORDS_RE.test(w) ? w : "ID"))
    .replace(/\s+/g, "");
}

export function buildShingleSet(normStr, k = 12) {
  const set = new Set();
  if (normStr.length < 45) return set;
  for (let i = 0; i <= normStr.length - k; i += 3) {
    set.add(normStr.slice(i, i + k));
  }
  return set;
}

export function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter++;
  }
  return inter / (setA.size + setB.size - inter);
}
