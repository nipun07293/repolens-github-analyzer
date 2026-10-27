import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { analyzeRepo, type RepoSnapshot } from "@/lib/repo.functions";
import { askRepo } from "@/lib/ask.functions";
import {
  extractSymbols, buildGraph, detectFindings, impactOf, findCycles, chunkFiles, bm25Search, isTestFile, tokenize,
  type CodeSymbol, type Finding,
} from "@/lib/analyzer/core";

const GraphView = lazy(() => import("@/components/GraphView"));

export const Route = createFileRoute("/analyze")({
  validateSearch: (s: Record<string, unknown>) => ({ repo: typeof s["repo"] === "string" ? s["repo"] : "" }),
  head: () => ({
    meta: [
      { title: "Repository analysis — RepoLens AI" },
      { name: "description", content: "Architecture, dependency graph, findings, change impact and cited Q&A for a GitHub repository." },
      { property: "og:title", content: "Repository analysis — RepoLens AI" },
      { property: "og:description", content: "Deterministic code analysis plus cited AI answers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AnalyzePage,
});

type Tab = "overview" | "files" | "graph" | "findings" | "impact" | "ask";

function useAnalysis(snap: RepoSnapshot | undefined) {
  return useMemo(() => {
    if (!snap) return null;
    const t0 = performance.now();
    const symbols: CodeSymbol[] = snap.files.flatMap(extractSymbols);
    const { edges, externalDeps } = buildGraph(snap.files);
    const findings: Finding[] = snap.files.flatMap(detectFindings);
    const cycles = findCycles(edges);
    const chunks = chunkFiles(snap.files);
    const loc = snap.files.reduce((s, f) => s + f.content.split("\n").length, 0);
    const frameworks = detectFrameworks(snap);
    return { symbols, edges, externalDeps, findings, cycles, chunks, loc, frameworks, analyzeMs: Math.round(performance.now() - t0) };
  }, [snap]);
}

function detectFrameworks(s: RepoSnapshot): string[] {
  const out = new Set<string>();
  const pkg = s.manifests["package.json"];
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      const deps = { ...j.dependencies, ...j.devDependencies };
      const map: Record<string, string> = { react: "React", next: "Next.js", vue: "Vue", express: "Express", fastify: "Fastify", "@nestjs/core": "NestJS", vite: "Vite", jest: "Jest", vitest: "Vitest", mocha: "Mocha", prisma: "Prisma", mongoose: "Mongoose", typescript: "TypeScript", svelte: "Svelte" };
      for (const k of Object.keys(deps)) if (map[k]) out.add(map[k]);
    } catch { /* invalid package.json */ }
  }
  const py = (s.manifests["requirements.txt"] ?? "") + (s.manifests["pyproject.toml"] ?? "");
  for (const [k, v] of [["django", "Django"], ["flask", "Flask"], ["fastapi", "FastAPI"], ["pytest", "pytest"], ["sqlalchemy", "SQLAlchemy"]] as const) if (py.toLowerCase().includes(k)) out.add(v);
  if (s.manifests["pom.xml"]?.includes("spring-boot")) out.add("Spring Boot");
  if (s.manifests["go.mod"]) out.add("Go modules");
  if (s.manifests["Dockerfile"]) out.add("Docker");
  if (s.allPaths.some((p) => p.startsWith(".github/workflows/"))) out.add("GitHub Actions");
  return [...out];
}

function AnalyzePage() {
  const { repo } = Route.useSearch();
  const analyze = useServerFn(analyzeRepo);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const q = useQuery({
    queryKey: ["repo", repo],
    queryFn: () => analyze({ data: { url: repo } }),
    enabled: mounted && !!repo,
    staleTime: Infinity,
    retry: false,
  });
  const a = useAnalysis(q.data);
  const [tab, setTab] = useState<Tab>("overview");
  const [open, setOpen] = useState<{ path: string; line?: number | undefined } | null>(null);

  useEffect(() => {
    if (!q.data) return;
    const hist = JSON.parse(localStorage.getItem("repolens-history") ?? "[]") as Array<{ repo: string; sha: string; at: number }>;
    const next = [{ repo, sha: q.data.sha, at: Date.now() }, ...hist.filter((h) => h.repo !== repo)].slice(0, 10);
    localStorage.setItem("repolens-history", JSON.stringify(next));
  }, [q.data, repo]);

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
          <Link to="/" className="font-mono text-sm font-semibold text-primary">repolens</Link>
          <span className="font-mono text-sm">{repo}</span>
          {q.data && <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{q.data.branch}@{q.data.sha.slice(0, 7)}</span>}
          {q.data && <button onClick={() => q.refetch()} className="ml-auto text-xs text-muted-foreground hover:text-primary">Reanalyze</button>}
        </div>
        {a && (
          <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-6">
            {(["overview", "files", "graph", "findings", "impact", "ask"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                {t === "ask" ? "Ask AI" : t}
                {t === "findings" && <span className="ml-1 text-xs">({a.findings.length})</span>}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="mx-auto max-w-7xl px-6 py-8">
        {(q.isLoading || (!mounted && repo)) && <Loading />}
        {q.error && (
          <div className="rounded-lg border border-destructive p-6">
            <p className="text-destructive">{(q.error as Error).message}</p>
            <button onClick={() => q.refetch()} className="mt-3 text-sm text-primary">Retry</button>
          </div>
        )}
        {!repo && <p>No repository selected. <Link to="/" className="text-primary">Go back</Link></p>}
        {q.data && a && (
          <>
            {tab === "overview" && <Overview s={q.data} a={a} />}
            {tab === "files" && <Files s={q.data} symbols={a.symbols} onOpen={setOpen} />}
            {tab === "graph" && (
              <Suspense fallback={<Loading />}>
                <p className="mb-3 text-sm text-muted-foreground">{a.edges.length} resolved dependency edges · top 90 most-connected files, grouped by folder · click a file to open it</p>
                <GraphView edges={a.edges} onSelect={(p) => setOpen({ path: p })} />
              </Suspense>
            )}
            {tab === "findings" && <Findings findings={a.findings} cycles={a.cycles} onOpen={setOpen} />}
            {tab === "impact" && <Impact s={q.data} a={a} onOpen={setOpen} />}
            {tab === "ask" && <Ask s={q.data} a={a} onOpen={setOpen} />}
          </>
        )}
      </div>
      {open && q.data && <CodeViewer s={q.data} path={open.path} line={open.line} onClose={() => setOpen(null)} />}
    </main>
  );
}

function Loading() {
  return (
    <div className="font-mono text-sm text-muted-foreground">
      <p className="animate-pulse">› fetching tree, resolving commit, downloading sources…</p>
    </div>
  );
}

type A = NonNullable<ReturnType<typeof useAnalysis>>;
type OpenFn = (o: { path: string; line?: number | undefined }) => void;

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl">{value}</p>
    </div>
  );
}

function Overview({ s, a }: { s: RepoSnapshot; a: A }) {
  const langTotal = Object.values(s.languages).reduce((x, y) => x + y, 0) || 1;
  const routes = a.symbols.filter((x) => x.kind === "route");
  const tests = s.allPaths.filter(isTestFile);
  const hubs = useMemo(() => {
    const inDeg = new Map<string, number>();
    for (const e of a.edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    return [...inDeg.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
  }, [a.edges]);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">{s.owner}/{s.repo}</h1>
        {s.description && <p className="mt-2 text-muted-foreground">{s.description}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Files in repo" value={s.totalFiles} />
        <Stat label="Files analyzed" value={s.files.length} />
        <Stat label="Lines analyzed" value={a.loc.toLocaleString()} />
        <Stat label="Symbols" value={a.symbols.length} />
        <Stat label="Dep. edges" value={a.edges.length} />
        <Stat label="Stars" value={s.stars.toLocaleString()} />
      </div>
      <p className="font-mono text-xs text-muted-foreground">fetch {s.fetchMs}ms · analysis {a.analyzeMs}ms · commit {s.sha} {s.license && `· ${s.license}`}</p>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-border p-5">
          <h2 className="font-semibold">Languages</h2>
          <div className="mt-3 space-y-2">
            {Object.entries(s.languages).slice(0, 6).map(([l, b]) => (
              <div key={l} className="text-sm">
                <div className="flex justify-between"><span>{l}</span><span className="font-mono text-muted-foreground">{((b / langTotal) * 100).toFixed(1)}%</span></div>
                <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${(b / langTotal) * 100}%` }} /></div>
              </div>
            ))}
          </div>
          <h2 className="mt-6 font-semibold">Detected stack</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {a.frameworks.length ? a.frameworks.map((f) => <span key={f} className="rounded border border-accent px-2 py-0.5 text-xs text-accent">{f}</span>) : <span className="text-sm text-muted-foreground">Nothing detected from manifests.</span>}
          </div>
        </section>
        <section className="rounded-lg border border-border p-5">
          <h2 className="font-semibold">Core modules <span className="text-xs font-normal text-muted-foreground">(most imported)</span></h2>
          <ul className="mt-3 space-y-1 font-mono text-xs">
            {hubs.map(([p, n]) => <li key={p} className="flex justify-between gap-2"><span className="truncate">{p}</span><span className="text-primary">{n}←</span></li>)}
            {!hubs.length && <li className="text-muted-foreground">No internal imports resolved.</li>}
          </ul>
          <h2 className="mt-6 font-semibold">API routes ({routes.length})</h2>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-xs">
            {routes.slice(0, 40).map((r, i) => <li key={i}><span className="text-accent">{r.detail}</span> {r.name} <span className="text-muted-foreground">— {r.path}:{r.line}</span></li>)}
          </ul>
        </section>
        <section className="rounded-lg border border-border p-5">
          <h2 className="font-semibold">External dependencies</h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(a.externalDeps).sort((x, y) => y[1] - x[1]).slice(0, 30).map(([d, n]) => <span key={d} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{d} <span className="text-muted-foreground">{n}</span></span>)}
          </div>
        </section>
        <section className="rounded-lg border border-border p-5">
          <h2 className="font-semibold">Testing & CI</h2>
          <p className="mt-2 text-sm">{tests.length} test files found in repo tree.</p>
          <p className="mt-1 text-sm">{s.allPaths.filter((p) => p.startsWith(".github/workflows/")).length} GitHub Actions workflows.</p>
          <p className="mt-1 text-sm">Manifests: <span className="font-mono text-xs">{Object.keys(s.manifests).join(", ") || "none"}</span></p>
          {s.skipped > 0 && <p className="mt-3 text-xs text-muted-foreground">Analysis covers the {s.files.length} highest-priority source files.</p>}
        </section>
      </div>
    </div>
  );
}

function Files({ s, symbols, onOpen }: { s: RepoSnapshot; symbols: CodeSymbol[]; onOpen: OpenFn }) {
  const [f, setF] = useState("");
  const list = symbols.filter((x) => !f || x.name.toLowerCase().includes(f.toLowerCase()) || x.path.toLowerCase().includes(f.toLowerCase())).slice(0, 300);
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_2fr]">
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border p-3 font-mono text-xs">
        {s.files.map((x) => <button key={x.path} onClick={() => onOpen({ path: x.path })} className="block w-full truncate py-0.5 text-left hover:text-primary">{x.path}</button>)}
      </div>
      <div>
        <input value={f} onChange={(e) => setF(e.target.value)} placeholder="Filter symbols or paths…" className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary" />
        <ul className="mt-3 max-h-[64vh] divide-y divide-border overflow-auto rounded-lg border border-border">
          {list.map((x, i) => (
            <li key={i}>
              <button onClick={() => onOpen({ path: x.path, line: x.line })} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted">
                <span className="w-16 shrink-0 text-xs text-accent">{x.kind}</span>
                <span className="font-mono">{x.detail ? `${x.detail} ` : ""}{x.name}</span>
                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{x.path}:{x.line}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const SEV = { high: "text-destructive", medium: "text-warning", low: "text-muted-foreground" };

function Findings({ findings, cycles, onOpen }: { findings: Finding[]; cycles: string[][]; onOpen: OpenFn }) {
  const [cat, setCat] = useState<string>("all");
  const order = { high: 0, medium: 1, low: 2 };
  const list = findings.filter((x) => cat === "all" || x.category === cat).sort((x, y) => order[x.severity] - order[y.severity]);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Pattern-based static checks on analyzed files. Findings are leads to review, not confirmed bugs.</p>
      <div className="flex gap-2">
        {["all", "security", "bug-risk", "maintainability"].map((c) => (
          <button key={c} onClick={() => setCat(c)} className={`rounded px-3 py-1 text-xs ${cat === c ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
            {c} ({c === "all" ? findings.length : findings.filter((x) => x.category === c).length})
          </button>
        ))}
      </div>
      {cycles.length > 0 && (
        <div className="rounded-lg border border-warning p-4 text-sm">
          <p className="font-semibold text-warning">{cycles.length} circular import group(s)</p>
          {cycles.slice(0, 5).map((c, i) => <p key={i} className="mt-1 font-mono text-xs">{c.join(" ↔ ")}</p>)}
        </div>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {list.slice(0, 300).map((x, i) => (
          <li key={i}>
            <button onClick={() => onOpen({ path: x.path, line: x.line })} className="w-full px-4 py-3 text-left hover:bg-muted">
              <div className="flex items-center gap-3 text-sm">
                <span className={`w-16 font-mono text-xs uppercase ${SEV[x.severity]}`}>{x.severity}</span>
                <span>{x.message}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{x.path}:{x.line}</span>
              </div>
              {x.snippet && <code className="mt-1 block truncate pl-[76px] font-mono text-xs text-muted-foreground">{x.snippet}</code>}
            </button>
          </li>
        ))}
        {!list.length && <li className="p-4 text-sm text-muted-foreground">No findings in this category.</li>}
      </ul>
    </div>
  );
}

function Impact({ s, a, onOpen }: { s: RepoSnapshot; a: A; onOpen: OpenFn }) {
  const [target, setTarget] = useState("");
  const [filter, setFilter] = useState("");
  const result = useMemo(() => (target ? impactOf(target, a.edges) : []), [target, a.edges]);
  const tests = result.filter((r) => isTestFile(r.path));
  const risk = result.length > 20 ? "High" : result.length > 5 ? "Medium" : "Low";
  const opts = s.files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 200);
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_2fr]">
      <div>
        <p className="text-sm text-muted-foreground">Pick a file you plan to change.</p>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search files…" className="mt-2 w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary" />
        <div className="mt-2 max-h-[60vh] overflow-auto rounded-lg border border-border p-2 font-mono text-xs">
          {opts.map((f) => <button key={f.path} onClick={() => setTarget(f.path)} className={`block w-full truncate px-2 py-1 text-left ${target === f.path ? "bg-primary text-primary-foreground" : "hover:text-primary"}`}>{f.path}</button>)}
        </div>
      </div>
      <div>
        {!target ? <p className="text-muted-foreground">Select a file to predict its blast radius.</p> : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Affected files" value={result.length} />
              <Stat label="Affected tests" value={tests.length} />
              <Stat label="Risk" value={<span className={risk === "High" ? "text-destructive" : risk === "Medium" ? "text-warning" : "text-accent"}>{risk}</span>} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Static import-graph analysis (reverse BFS). Dynamic imports and runtime wiring are not included.</p>
            <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
              {result.map((r) => (
                <li key={r.path}>
                  <button onClick={() => onOpen({ path: r.path })} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted">
                    <span className="w-14 font-mono text-xs text-primary">depth {r.depth}</span>
                    <span className="font-mono text-xs">{r.path}</span>
                    {isTestFile(r.path) && <span className="rounded bg-accent px-1.5 text-xs text-accent-foreground">test</span>}
                    <span className="ml-auto truncate font-mono text-xs text-muted-foreground">via {r.via.split("/").pop()}</span>
                  </button>
                </li>
              ))}
              {!result.length && <li className="p-4 text-sm text-muted-foreground">No analyzed file imports this one.</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Ask({ s, a, onOpen }: { s: RepoSnapshot; a: A; onOpen: OpenFn }) {
  const ask = useServerFn(askRepo);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Array<{ q: string; answer?: string; error?: string; sources: Array<{ path: string; start: number; end: number }> }>>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (qText: string) => {
    if (!qText.trim() || busy) return;
    const chunks = bm25Search(a.chunks, qText, 8);
    const toks = new Set(tokenize(qText));
    const syms = a.symbols.filter((x) => tokenize(x.name).some((t) => toks.has(t))).slice(0, 60).map((x) => `${x.kind} ${x.name} @ ${x.path}:${x.line}`).join("\n");
    const sources = chunks.map(({ path, start, end }) => ({ path, start, end }));
    setBusy(true);
    setHistory((h) => [{ q: qText, sources }, ...h]);
    setQuestion("");
    try {
      if (!chunks.length) throw new Error("No matching code found for those words. Try naming a feature, file or function.");
      const r = await ask({ data: { question: qText, repo: `${s.owner}/${s.repo}`, sha: s.sha, symbols: syms, chunks: chunks.map(({ path, start, end, text }) => ({ path, start, end, text })) } });
      setHistory((h) => h.map((x, i) => (i === 0 ? { ...x, answer: r.answer } : x)));
    } catch (e) {
      setHistory((h) => h.map((x, i) => (i === 0 ? { ...x, error: (e as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  };
  const SUGG = ["Where is routing implemented?", "How does error handling work?", "Where is configuration loaded?", "What are the main entry points?"];
  return (
    <div className="mx-auto max-w-3xl">
      <form onSubmit={(e) => { e.preventDefault(); submit(question); }} className="flex gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Where is authentication implemented?" className="flex-1 rounded-md border border-input bg-card px-4 py-3 text-sm outline-none focus:border-primary" />
        <button disabled={busy} className="rounded-md bg-primary px-5 font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Thinking…" : "Ask"}</button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUGG.map((x) => <button key={x} onClick={() => submit(x)} className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary">{x}</button>)}
      </div>
      <div className="mt-8 space-y-6">
        {history.map((h, i) => (
          <article key={i} className="rounded-lg border border-border p-5">
            <p className="font-semibold">{h.q}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {h.sources.map((src, j) => <button key={j} onClick={() => onOpen({ path: src.path, line: src.start })} className="rounded bg-muted px-2 py-0.5 font-mono text-xs hover:text-primary">{src.path}:{src.start}-{src.end}</button>)}
            </div>
            {h.error && <p className="mt-3 text-sm text-destructive">{h.error}</p>}
            {!h.answer && !h.error && <p className="mt-3 animate-pulse text-sm text-muted-foreground">Reading {h.sources.length} excerpts…</p>}
            {h.answer && <Answer text={h.answer} onOpen={onOpen} />}
            <p className="mt-3 font-mono text-xs text-muted-foreground">commit {s.sha.slice(0, 7)} · statically inferred</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function Answer({ text, onOpen }: { text: string; onOpen: OpenFn }) {
  return (
    <div className="mt-4 space-y-1.5 text-sm leading-relaxed">
      {text.split("\n").map((line, i) => {
        const h = line.match(/^#{1,4}\s+(.*)/);
        const content = ((h ? h[1] : line) ?? "").split(/(\[[^\]\s]+:\d+(?:-\d+)?\]|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => {
          const c = part.match(/^\[([^\]\s]+):(\d+)(?:-\d+)?\]$/);
          if (c && c[1] && c[2]) return <button key={j} onClick={() => onOpen({ path: c[1]!, line: Number(c[2]) })} className="mx-0.5 rounded bg-muted px-1 font-mono text-xs text-primary hover:underline">{c[1].split("/").pop()}:{c[2]}</button>;
          if (part.startsWith("**")) return <strong key={j}>{part.slice(2, -2)}</strong>;
          if (part.startsWith("`")) return <code key={j} className="rounded bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
          return part;
        });
        if (h) return <h3 key={i} className="pt-2 font-semibold text-primary">{content}</h3>;
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i}>{content}</p>;
      })}
    </div>
  );
}

function CodeViewer({ s, path, line, onClose }: { s: RepoSnapshot; path: string; line?: number | undefined; onClose: () => void }) {
  const file = s.files.find((f) => f.path === path);
  useEffect(() => {
    if (line) document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" });
  }, [line, path]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/70" onClick={onClose}>
      <div className="flex h-full w-full max-w-3xl flex-col border-l border-border bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="truncate font-mono text-sm">{path}</span>
          <a href={`https://github.com/${s.owner}/${s.repo}/blob/${s.sha}/${path}${line ? `#L${line}` : ""}`} target="_blank" rel="noreferrer" className="ml-auto text-xs text-primary">GitHub ↗</a>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">Close</button>
        </div>
        <pre className="flex-1 overflow-auto p-0 font-mono text-xs">
          {(file?.content ?? "File not in analyzed set.").split("\n").map((l, i) => (
            <div key={i} id={`L${i + 1}`} className={`flex ${line && i + 1 >= line && i + 1 < line + 1 ? "bg-primary/20" : ""}`}>
              <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground">{i + 1}</span>
              <span className="whitespace-pre">{l}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
