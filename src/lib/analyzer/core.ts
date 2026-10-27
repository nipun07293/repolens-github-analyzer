// Pure, deterministic code-analysis engine. No network, no AI — fully unit-testable.

export type Lang = "ts" | "js" | "py" | "java" | "go" | "rb" | "other";

export interface SourceFile {
  path: string;
  content: string;
  size: number;
}

export type SymbolKind = "function" | "class" | "interface" | "method" | "route" | "type";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  detail?: string;
}

export interface Finding {
  rule: string;
  severity: "high" | "medium" | "low";
  category: "security" | "bug-risk" | "maintainability";
  path: string;
  line: number;
  message: string;
  snippet: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "IMPORTS" | "TESTS";
}

export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.*)?$/) ??
    s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const owner = m[1]!, repo = m[2]!;
  if (owner.startsWith(".") || repo.startsWith(".")) return null;
  return { owner, repo };
}

export function langOf(path: string): Lang {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "ts";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (ext === "py") return "py";
  if (ext === "java" || ext === "kt") return "java";
  if (ext === "go") return "go";
  if (ext === "rb") return "rb";
  return "other";
}

export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(path) || /[._-](test|spec)\.[a-z]+$/i.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
}

const RULES: Array<{ lang: Lang[]; kind: SymbolKind; re: RegExp; name?: number; detail?: number }> = [
  { lang: ["ts", "js"], kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { lang: ["ts", "js"], kind: "function", re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/ },
  { lang: ["ts", "js"], kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { lang: ["ts"], kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { lang: ["ts"], kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/ },
  { lang: ["ts", "js"], kind: "route", re: /\b(?:app|router|server|r)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/i, name: 2, detail: 1 },
  { lang: ["py"], kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { lang: ["py"], kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  { lang: ["py"], kind: "route", re: /@\w+\.(get|post|put|patch|delete|route)\(\s*["']([^"']+)["']/i, name: 2, detail: 1 },
  { lang: ["java"], kind: "class", re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?(?:class|record|enum)\s+([A-Za-z_]\w*)/ },
  { lang: ["java"], kind: "interface", re: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/ },
  { lang: ["java"], kind: "method", re: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s]+\s+([a-z_]\w*)\s*\([^;]*$/ },
  { lang: ["java"], kind: "route", re: /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?"([^"]+)"/, name: 2, detail: 1 },
  { lang: ["go"], kind: "function", re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { lang: ["go"], kind: "class", re: /^type\s+([A-Za-z_]\w*)\s+struct/ },
  { lang: ["go"], kind: "interface", re: /^type\s+([A-Za-z_]\w*)\s+interface/ },
  { lang: ["rb"], kind: "function", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/ },
  { lang: ["rb"], kind: "class", re: /^\s*class\s+([A-Z]\w*)/ },
];

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else"]);

export function extractSymbols(file: SourceFile): CodeSymbol[] {
  const lang = langOf(file.path);
  if (lang === "other") return [];
  const out: CodeSymbol[] = [];
  const lines = file.content.split("\n");
  const rules = RULES.filter((r) => r.lang.includes(lang));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    for (const r of rules) {
      const m = line.match(r.re);
      if (!m) continue;
      const name = m[r.name ?? 1];
      if (!name || KEYWORDS.has(name)) continue;
      const sym: CodeSymbol = { name, kind: r.kind, path: file.path, line: i + 1 };
      if (r.detail && m[r.detail]) sym.detail = m[r.detail]!.toUpperCase();
      out.push(sym);
      break;
    }
  }
  return out;
}

/** Extract raw import specifiers from a file. */
export function extractImports(file: SourceFile): string[] {
  const lang = langOf(file.path);
  const specs: string[] = [];
  const c = file.content;
  if (lang === "ts" || lang === "js") {
    for (const m of c.matchAll(/(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g)) specs.push(m[1]!);
    for (const m of c.matchAll(/(?:require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) specs.push(m[1]!);
  } else if (lang === "py") {
    for (const m of c.matchAll(/^\s*from\s+([.\w]+)\s+import/gm)) specs.push(m[1]!);
    for (const m of c.matchAll(/^\s*import\s+([\w.]+)/gm)) specs.push(m[1]!);
  } else if (lang === "java") {
    for (const m of c.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) specs.push(m[1]!);
  } else if (lang === "go") {
    for (const m of c.matchAll(/"([\w./-]+)"/g)) specs.push(m[1]!);
  }
  return [...new Set(specs)];
}

function dirname(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Resolve an import specifier to a file path in the repo (or null for external deps). */
export function resolveImport(fromPath: string, spec: string, fileSet: Set<string>): string | null {
  const lang = langOf(fromPath);
  const tryCandidates = (base: string) => {
    const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", "/index.ts", "/index.tsx", "/index.js", "/__init__.py"];
    for (const e of exts) if (fileSet.has(base + e)) return base + e;
    return null;
  };
  if (lang === "ts" || lang === "js") {
    if (spec.startsWith(".")) return tryCandidates(normalize(dirname(fromPath) + "/" + spec.replace(/\.js$/, "")));
    if (spec.startsWith("@/") || spec.startsWith("~/")) return tryCandidates(normalize("src/" + spec.slice(2))) ?? tryCandidates(normalize(spec.slice(2)));
    return null;
  }
  if (lang === "py") {
    let base: string;
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)![0].length;
      let d = dirname(fromPath);
      for (let i = 1; i < dots; i++) d = dirname(d);
      base = normalize(d + "/" + spec.slice(dots).replace(/\./g, "/"));
    } else base = spec.replace(/\./g, "/");
    const direct = tryCandidates(base);
    if (direct) return direct;
    for (const f of fileSet) if (f.endsWith("/" + base + ".py")) return f;
    return null;
  }
  if (lang === "java") {
    const suffix = spec.replace(/\./g, "/") + ".java";
    for (const f of fileSet) if (f.endsWith(suffix)) return f;
    return null;
  }
  return null;
}

export function buildGraph(files: SourceFile[]): { edges: GraphEdge[]; externalDeps: Record<string, number> } {
  const fileSet = new Set(files.map((f) => f.path));
  const edges: GraphEdge[] = [];
  const externalDeps: Record<string, number> = {};
  for (const f of files) {
    for (const spec of extractImports(f)) {
      const target = resolveImport(f.path, spec, fileSet);
      if (target && target !== f.path) edges.push({ from: f.path, to: target, kind: isTestFile(f.path) ? "TESTS" : "IMPORTS" });
      else if (!target && !spec.startsWith(".")) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split(/[/.]/)[0] ?? spec);
        externalDeps[pkg] = (externalDeps[pkg] ?? 0) + 1;
      }
    }
  }
  return { edges, externalDeps };
}

/**
 * Change impact: reverse BFS over the dependency graph.
 * Returns every file that transitively depends on `target`, with its distance.
 */
export function impactOf(target: string, edges: GraphEdge[], maxDepth = 6): Array<{ path: string; depth: number; via: string }> {
  const reverse = new Map<string, string[]>();
  for (const e of edges) {
    if (!reverse.has(e.to)) reverse.set(e.to, []);
    reverse.get(e.to)!.push(e.from);
  }
  const seen = new Map<string, { depth: number; via: string }>();
  const queue: Array<[string, number]> = [[target, 0]];
  seen.set(target, { depth: 0, via: target });
  let head = 0;
  while (head < queue.length) {
    const [node, d] = queue[head++]!;
    if (d >= maxDepth) continue;
    for (const dep of reverse.get(node) ?? []) {
      if (seen.has(dep)) continue;
      seen.set(dep, { depth: d + 1, via: node });
      queue.push([dep, d + 1]);
    }
  }
  seen.delete(target);
  return [...seen.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

/** Detect import cycles with Tarjan's strongly connected components. */
export function findCycles(edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const nodes = new Set([...edges.map((e) => e.from), ...edges.map((e) => e.to)]);
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return out;
}

const FINDING_RULES: Array<{ rule: string; severity: Finding["severity"]; category: Finding["category"]; re: RegExp; message: string; langs?: Lang[] }> = [
  { rule: "eval-usage", severity: "high", category: "security", re: /\beval\s*\(/, message: "eval() executes arbitrary code; avoid dynamic evaluation.", langs: ["ts", "js", "py"] },
  { rule: "hardcoded-secret", severity: "high", category: "security", re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{12,}["']/i, message: "Possible hardcoded credential." },
  { rule: "aws-key", severity: "high", category: "security", re: /AKIA[0-9A-Z]{16}/, message: "Looks like an AWS access key ID." },
  { rule: "sql-concat", severity: "high", category: "security", re: /["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*["'`]\s*\+\s*\w/i, message: "SQL built by string concatenation — risk of SQL injection; use parameters." },
  { rule: "sql-template", severity: "medium", category: "security", re: /`\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i, message: "SQL template literal with interpolation — verify inputs are parameterized.", langs: ["ts", "js"] },
  { rule: "inner-html", severity: "medium", category: "security", re: /\.innerHTML\s*=|dangerouslySetInnerHTML/, message: "Raw HTML injection point — potential XSS.", langs: ["ts", "js"] },
  { rule: "shell-exec", severity: "medium", category: "security", re: /\b(?:child_process\.exec|execSync|os\.system|subprocess\.(?:call|run|Popen)\([^)]*shell\s*=\s*True)/, message: "Shell command execution — check for command injection." },
  { rule: "empty-catch", severity: "medium", category: "bug-risk", re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/, message: "Empty catch block silently swallows errors." },
  { rule: "bare-except", severity: "medium", category: "bug-risk", re: /^\s*except\s*:/, message: "Bare except catches everything, including KeyboardInterrupt.", langs: ["py"] },
  { rule: "loose-equality", severity: "low", category: "bug-risk", re: /[^=!]==[^=]|!=[^=]/, message: "Loose equality (==) can coerce types unexpectedly.", langs: ["js"] },
  { rule: "todo", severity: "low", category: "maintainability", re: /\b(?:TODO|FIXME|HACK|XXX)\b/, message: "Unresolved TODO/FIXME marker." },
];

export function detectFindings(file: SourceFile): Finding[] {
  const lang = langOf(file.path);
  if (lang === "other") return [];
  const out: Finding[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 500) continue;
    for (const r of FINDING_RULES) {
      if (r.langs && !r.langs.includes(lang)) continue;
      if (r.rule === "loose-equality" && /^\s*(\/\/|\*)/.test(line)) continue;
      if (r.re.test(line)) out.push({ rule: r.rule, severity: r.severity, category: r.category, path: file.path, line: i + 1, message: r.message, snippet: line.trim().slice(0, 160) });
    }
  }
  if (lines.length > 600 && !isTestFile(file.path))
    out.push({ rule: "large-file", severity: "low", category: "maintainability", path: file.path, line: 1, message: `File has ${lines.length} lines; consider splitting.`, snippet: "" });
  return out;
}

// ---------- BM25 retrieval over line-windowed chunks ----------

export interface Chunk {
  path: string;
  start: number;
  end: number;
  text: string;
}

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}
const STOP = new Set(["the", "is", "a", "an", "of", "to", "in", "and", "or", "how", "does", "what", "where", "which", "when", "it", "this", "that", "for", "on", "be", "do", "are", "with", "import", "from", "const", "return", "export", "function"]);

export function chunkFiles(files: SourceFile[], window = 40): Chunk[] {
  const chunks: Chunk[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let s = 0; s < lines.length; s += window) {
      const e = Math.min(lines.length, s + window);
      chunks.push({ path: f.path, start: s + 1, end: e, text: lines.slice(s, e).join("\n") });
    }
  }
  return chunks;
}

export function bm25Search(chunks: Chunk[], query: string, k = 8): Array<Chunk & { score: number }> {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const docs = chunks.map((c) => tokenize(c.path + " " + c.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const k1 = 1.4, b = 0.75;
  const scored = chunks.map((c, i) => {
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    if (q.some((t) => c.path.toLowerCase().includes(t))) score *= 1.3;
    if (isTestFile(c.path) && !q.includes("test")) score *= 0.6;
    return { ...c, score };
  });
  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
