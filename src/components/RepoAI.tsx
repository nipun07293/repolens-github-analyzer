import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { explainRepo, agentStep } from "@/lib/ask.functions";
import { bm25Search, impactOf, extractJson, type CodeSymbol, type Finding, type GraphEdge, type Chunk, type SourceFile } from "@/lib/analyzer/core";
import type { RepoSnapshot } from "@/lib/repo.functions";
import { Markdown, ModelPicker } from "./Markdown";

type OpenFn = (o: { path: string; line?: number | undefined }) => void;
type Model = "gpt" | "gemini";
export interface AIProps {
  s: RepoSnapshot;
  a: { symbols: CodeSymbol[]; edges: GraphEdge[]; findings: Finding[]; chunks: Chunk[]; frameworks: string[]; loc: number; cycles: string[][]; externalDeps: Record<string, number> };
  facts: string;
  onOpen: OpenFn;
}

export function repoFacts(s: RepoSnapshot, a: AIProps["a"], health: { overall: number; grade: string; parts: Record<string, number> }): string {
  const inDeg = new Map<string, number>();
  for (const e of a.edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  const hubs = [...inDeg.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([p, n]) => `${p} (imported by ${n})`);
  const dirs = [...new Set(s.allPaths.map((p) => p.split("/")[0]))].slice(0, 30);
  const routes = a.symbols.filter((x) => x.kind === "route").slice(0, 20).map((r) => `${r.detail} ${r.name} @ ${r.path}:${r.line}`);
  const fc: Record<string, number> = {};
  for (const f of a.findings) fc[`${f.category}/${f.severity}`] = (fc[`${f.category}/${f.severity}`] ?? 0) + 1;
  return [
    `Description: ${s.description ?? "none"}; stars ${s.stars}; license ${s.license ?? "none"}`,
    `Languages: ${Object.keys(s.languages).join(", ")}`,
    `Detected stack: ${a.frameworks.join(", ") || "unknown"}`,
    `Top-level entries: ${dirs.join(", ")}`,
    `Files ${s.totalFiles} (analyzed ${s.files.length}), lines analyzed ${a.loc}, symbols ${a.symbols.length}, import edges ${a.edges.length}, cycles ${a.cycles.length}`,
    `Core modules: ${hubs.join("; ") || "none"}`,
    `Routes: ${routes.join("; ") || "none"}`,
    `External deps: ${Object.keys(a.externalDeps).slice(0, 25).join(", ")}`,
    `Health ${health.overall}/100 grade ${health.grade} ${JSON.stringify(health.parts)}`,
    `Findings: ${JSON.stringify(fc)}`,
    `Manifests:\n${Object.entries(s.manifests).filter(([k]) => !/^readme/i.test(k)).map(([k, v]) => `# ${k}\n${v.slice(0, 1500)}`).join("\n")}`,
  ].join("\n");
}

export function Explain({ s, facts, onOpen }: AIProps) {
  const explain = useServerFn(explainRepo);
  const [model, setModel] = useState<Model>("gpt");
  const [level, setLevel] = useState<"beginner" | "developer">("beginner");
  const [res, setRes] = useState<{ answer: string; model: string; ms: number } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const readme = Object.entries(s.manifests).find(([k]) => /^readme/i.test(k))?.[1] ?? "";
  const run = async () => {
    setBusy(true); setErr(""); setRes(null);
    try { setRes(await explain({ data: { repo: `${s.owner}/${s.repo}`, facts, readme, level, model } })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Explain this project to me</h1>
      <p className="mt-1 text-sm text-muted-foreground">A plain-language guide: what it does, how it works, how to run it, and a glossary of terms — built from the real code facts and README.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
          {(["beginner", "developer"] as const).map((l) => <button key={l} onClick={() => setLevel(l)} className={`rounded px-3 py-1 capitalize ${level === l ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}>{l}</button>)}
        </div>
        <ModelPicker value={model} onChange={setModel} />
        <button onClick={run} disabled={busy} className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Writing guide…" : res ? "Regenerate" : "Generate guide"}</button>
      </div>
      {busy && <p className="mt-6 animate-pulse font-mono text-sm text-muted-foreground">› reading README, manifests and code structure…</p>}
      {err && <p className="mt-6 text-sm text-destructive">{err}</p>}
      {res && (
        <article className="mt-6 rounded-lg border border-border bg-card p-6">
          <Markdown text={res.answer} onOpen={onOpen} />
          <p className="mt-4 font-mono text-xs text-muted-foreground">{res.model} · {(res.ms / 1000).toFixed(1)}s · commit {s.sha.slice(0, 7)}</p>
        </article>
      )}
    </div>
  );
}

interface Step { thought: string; tool: string; args: string; observation: string; ms?: number }
const MAX_STEPS = 7;
const PLAYBOOKS = [
  { label: "Security audit", goal: "Audit this repository for security vulnerabilities (injection, secrets, unsafe eval, auth gaps). Rank them by severity." },
  { label: "Trace a request", goal: "Trace how a typical request or main user action flows from the entry point through the code to data access." },
  { label: "Onboarding tour", goal: "Give a new contributor a guided tour: entry points, core modules, and where to start making a first change." },
  { label: "Bug hunt", goal: "Find the most likely places where bugs hide: error handling gaps, swallowed exceptions, and fragile, highly-coupled files." },
  { label: "Refactor plan", goal: "Identify the riskiest, most coupled files and propose a safe refactoring plan with their change impact." },
];

function runTool(tool: string, args: Record<string, unknown>, files: SourceFile[], a: AIProps["a"]): string {
  const str = (k: string) => String(args[k] ?? "").trim();
  switch (tool) {
    case "search": {
      const hits = bm25Search(a.chunks, str("query"), 4);
      return hits.length ? hits.map((h) => `[${h.path}:${h.start}-${h.end}]\n${h.text.slice(0, 1100)}`).join("\n\n") : "No matches.";
    }
    case "read": {
      const path = str("path");
      const f = files.find((x) => x.path === path) ?? files.find((x) => x.path.endsWith(path));
      if (!f) return `File not found among analyzed files. Similar: ${files.filter((x) => x.path.includes(path.split("/").pop() ?? "")).slice(0, 5).map((x) => x.path).join(", ") || "none"}`;
      const start = Math.max(1, Number(args["start"]) || 1);
      const lines = f.content.split("\n").slice(start - 1, start + 59);
      return `[${f.path}:${start}-${start + lines.length - 1}]\n${lines.map((l, i) => `${start + i}| ${l}`).join("\n")}`;
    }
    case "symbol": {
      const n = str("name").toLowerCase();
      const hits = a.symbols.filter((s) => s.name.toLowerCase() === n || s.name.toLowerCase().includes(n)).slice(0, 12);
      return hits.length ? hits.map((s) => `${s.kind} ${s.name} @ ${s.path}:${s.line}`).join("\n") : "No symbol found.";
    }
    case "impact": {
      const path = str("path");
      const imp = impactOf(path, a.edges);
      return imp.length ? `${imp.length} dependent files:\n` + imp.slice(0, 30).map((x) => `depth ${x.depth}: ${x.path} (via ${x.via})`).join("\n") : "No dependents (leaf file or unresolved path).";
    }
    case "findings": {
      const path = str("path");
      const f = a.findings.filter((x) => !path || x.path.includes(path)).sort((x, y) => (x.severity === "high" ? -1 : 1) - (y.severity === "high" ? -1 : 1)).slice(0, 20);
      return f.length ? f.map((x) => `${x.severity} ${x.rule} [${x.path}:${x.line}-${x.line}] ${x.snippet}`).join("\n") : "No findings.";
    }
    default:
      return `Unknown tool "${tool}". Use search, read, symbol, impact, findings or answer.`;
  }
}

const ICON: Record<string, string> = { search: "⌕", read: "▤", symbol: "ƒ", impact: "⇶", findings: "⚠", answer: "✓" };

export function Agent({ s, a, facts, onOpen }: AIProps) {
  const step = useServerFn(agentStep);
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState<Model>("gpt");
  const [steps, setSteps] = useState<Step[]>([]);
  const [report, setReport] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ model: string; ms: number } | null>(null);
  const overview = useMemo(() => facts.slice(0, 3500), [facts]);

  const run = async (g: string) => {
    if (!g.trim() || busy) return;
    setGoal(g); setBusy(true); setErr(""); setReport(""); setSteps([]); setMeta(null);
    const t0 = Date.now();
    const done: Step[] = [];
    try {
      for (let i = 0; i <= MAX_STEPS; i++) {
        const ts = Date.now();
        const r = await step({ data: { repo: `${s.owner}/${s.repo}`, goal: g, overview, steps: done, forceAnswer: i === MAX_STEPS, model } });
        const call = extractJson<{ thought?: string; tool?: string; args?: Record<string, unknown> }>(r.raw);
        if (!call?.tool) { setReport(r.raw); break; }
        if (call.tool === "answer") { setReport(String(call.args?.["report"] ?? r.raw)); setMeta({ model: r.model, ms: Date.now() - t0 }); break; }
        const args = call.args ?? {};
        const key = `${call.tool}${JSON.stringify(args)}`;
        const dup = done.some((d) => `${d.tool}${d.args}` === key);
        const observation = dup ? "You already made this exact call. Try something different or answer." : runTool(call.tool, args, s.files, a);
        done.push({ thought: call.thought ?? "", tool: call.tool, args: JSON.stringify(args), observation, ms: Date.now() - ts });
        setSteps([...done]);
        setMeta({ model: r.model, ms: Date.now() - t0 });
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <div>
        <h1 className="text-2xl font-bold">Investigator agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">Give it a goal. The AI plans, calls real analysis tools (code search, file reader, symbol lookup, impact analysis, findings) step by step, then writes a cited report.</p>
        <form onSubmit={(e) => { e.preventDefault(); run(goal); }} className="mt-4 space-y-2">
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="e.g. How is user input validated, and where could it break?" className="w-full rounded-md border border-input bg-card p-3 text-sm outline-none focus:border-primary" />
          <div className="flex items-center gap-3">
            <ModelPicker value={model} onChange={setModel} />
            <button disabled={busy} className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Investigating…" : "Run agent"}</button>
          </div>
        </form>
        <p className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">Playbooks</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PLAYBOOKS.map((p) => <button key={p.label} disabled={busy} onClick={() => run(p.goal)} className="rounded border border-border px-3 py-1.5 text-xs hover:border-primary hover:text-primary disabled:opacity-50">{p.label}</button>)}
        </div>
        <ol className="relative mt-6 space-y-3 border-l border-border pl-5">
          {steps.map((st, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[29px] flex h-6 w-6 items-center justify-center rounded-full border border-primary bg-background text-xs text-primary">{ICON[st.tool] ?? "•"}</span>
              <p className="text-sm"><span className="font-mono text-xs text-accent">{st.tool}</span> <span className="font-mono text-xs text-muted-foreground">{st.args}</span></p>
              <p className="text-xs italic text-muted-foreground">{st.thought}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-primary">observation · {st.ms}ms</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{st.observation}</pre>
              </details>
            </li>
          ))}
          {busy && <li className="animate-pulse text-sm text-muted-foreground">thinking about step {steps.length + 1}…</li>}
        </ol>
      </div>
      <div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {report ? (
          <article className="rounded-lg border border-border bg-card p-6">
            <h2 className="font-semibold">Report</h2>
            <Markdown text={report} onOpen={onOpen} />
            {meta && <p className="mt-4 font-mono text-xs text-muted-foreground">{meta.model} · {steps.length} tool calls · {(meta.ms / 1000).toFixed(1)}s · statically inferred</p>}
          </article>
        ) : (
          !busy && <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">The agent's final cited report appears here. Each step on the left is a real tool run against this commit.</div>
        )}
      </div>
    </div>
  );
}
