import { useMemo } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Treemap, RadarChart, PolarGrid, PolarAngleAxis, Radar } from "recharts";
import { dirStats, healthScore, isTestFile, type CodeSymbol, type Finding, type GraphEdge, type SourceFile } from "@/lib/analyzer/core";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--primary)", "var(--accent)"];
const tip = { contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, color: "var(--popover-foreground)" } };

export interface InsightsProps {
  files: SourceFile[];
  allPaths: string[];
  languages: Record<string, number>;
  symbols: CodeSymbol[];
  findings: Finding[];
  edges: GraphEdge[];
  cycles: string[][];
  loc: number;
  onOpen: (o: { path: string; line?: number }) => void;
}

function Card({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}

export function useHealth(p: Pick<InsightsProps, "findings" | "loc" | "files" | "allPaths" | "cycles" | "edges">) {
  return useMemo(() => {
    const code = p.allPaths.filter((x) => /\.(ts|tsx|js|jsx|py|java|go|rb|kt)$/.test(x));
    return healthScore({ findings: p.findings, loc: p.loc, files: code.length, testFiles: code.filter(isTestFile).length, cycles: p.cycles.length, edges: p.edges.length });
  }, [p.findings, p.loc, p.allPaths, p.cycles, p.edges]);
}

export function HealthBadge({ score }: { score: ReturnType<typeof healthScore> }) {
  const pct = score.overall;
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-24 w-24 rounded-full" style={{ background: `conic-gradient(var(--primary) ${pct * 3.6}deg, var(--muted) 0)` }}>
        <div className="absolute inset-2 flex flex-col items-center justify-center rounded-full bg-card">
          <span className="font-mono text-2xl font-bold">{pct}</span>
          <span className="text-[10px] uppercase text-muted-foreground">grade {score.grade}</span>
        </div>
      </div>
      <div className="space-y-1 text-xs">
        {Object.entries(score.parts).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="w-28 capitalize text-muted-foreground">{k}</span>
            <div className="h-1.5 w-28 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${v}%` }} /></div>
            <span className="font-mono">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Insights(p: InsightsProps) {
  const health = useHealth(p);
  const lang = useMemo(() => {
    const tot = Object.values(p.languages).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(p.languages).slice(0, 7).map(([name, v]) => ({ name, value: +((v / tot) * 100).toFixed(1) }));
  }, [p.languages]);
  const dirs = useMemo(() => dirStats(p.files, 2).slice(0, 30).map((d) => ({ name: d.dir, size: d.lines })), [p.files]);
  const kinds = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of p.symbols) m[s.kind] = (m[s.kind] ?? 0) + 1;
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  }, [p.symbols]);
  const sev = useMemo(() => (["security", "bug-risk", "maintainability"] as const).map((c) => ({
    name: c,
    high: p.findings.filter((f) => f.category === c && f.severity === "high").length,
    medium: p.findings.filter((f) => f.category === c && f.severity === "medium").length,
    low: p.findings.filter((f) => f.category === c && f.severity === "low").length,
  })), [p.findings]);
  const biggest = useMemo(() => p.files.map((f) => ({ name: f.path.split("/").pop()!, path: f.path, lines: f.content.split("\n").length })).sort((a, b) => b.lines - a.lines).slice(0, 10), [p.files]);
  const coupling = useMemo(() => {
    const inD = new Map<string, number>(), outD = new Map<string, number>();
    for (const e of p.edges) { inD.set(e.to, (inD.get(e.to) ?? 0) + 1); outD.set(e.from, (outD.get(e.from) ?? 0) + 1); }
    const all = new Set([...inD.keys(), ...outD.keys()]);
    return [...all].map((path) => ({ name: path.split("/").pop()!, path, in: inD.get(path) ?? 0, out: outD.get(path) ?? 0 })).sort((a, b) => b.in + b.out - (a.in + a.out)).slice(0, 10);
  }, [p.edges]);
  const radar = Object.entries(health.parts).map(([k, v]) => ({ k, v }));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Project health" hint="0–100 score from findings per 1k lines, test ratio and import cycles. Higher is better.">
        <div className="flex flex-wrap items-center gap-6">
          <HealthBadge score={health} />
          <div className="h-48 min-w-[200px] flex-1">
            <ResponsiveContainer><RadarChart data={radar}><PolarGrid stroke="var(--border)" /><PolarAngleAxis dataKey="k" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} /><Radar dataKey="v" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.35} /></RadarChart></ResponsiveContainer>
          </div>
        </div>
      </Card>
      <Card title="Languages" hint="Share of code by language, as reported by GitHub.">
        <div className="h-56"><ResponsiveContainer><PieChart><Pie data={lang} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2} label={(e: { name: string; value: number }) => `${e.name} ${e.value}%`} labelLine={false} fontSize={11}>{lang.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip {...tip} /></PieChart></ResponsiveContainer></div>
      </Card>
      <Card title="Where the code lives" hint="Each box is a folder; bigger box = more lines of code.">
        <div className="h-64"><ResponsiveContainer><Treemap data={dirs} dataKey="size" nameKey="name" stroke="var(--background)" fill="var(--chart-2)" content={<TreeCell />} /></ResponsiveContainer></div>
      </Card>
      <Card title="Issues found" hint="Static-analysis findings by type and severity.">
        <div className="h-64"><ResponsiveContainer><BarChart data={sev}><XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} /><YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} /><Tooltip {...tip} cursor={{ fill: "var(--muted)" }} /><Bar dataKey="high" stackId="a" fill="var(--destructive)" /><Bar dataKey="medium" stackId="a" fill="var(--chart-4)" /><Bar dataKey="low" stackId="a" fill="var(--chart-2)" /></BarChart></ResponsiveContainer></div>
      </Card>
      <Card title="Largest files" hint="Long files are harder to understand and change. Click a bar to open the file.">
        <div className="h-64"><ResponsiveContainer><BarChart data={biggest} layout="vertical" margin={{ left: 20 }}><XAxis type="number" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} /><YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} /><Tooltip {...tip} cursor={{ fill: "var(--muted)" }} /><Bar dataKey="lines" fill="var(--primary)" onClick={(d: { path?: string }) => d.path && p.onOpen({ path: d.path })} className="cursor-pointer" /></BarChart></ResponsiveContainer></div>
      </Card>
      <Card title="Most connected files" hint="Imported-by (in) vs imports (out). High 'in' = risky to change.">
        <div className="h-64"><ResponsiveContainer><BarChart data={coupling} layout="vertical" margin={{ left: 20 }}><XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} /><YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} /><Tooltip {...tip} cursor={{ fill: "var(--muted)" }} /><Bar dataKey="in" stackId="c" fill="var(--accent)" onClick={(d: { path?: string }) => d.path && p.onOpen({ path: d.path })} /><Bar dataKey="out" stackId="c" fill="var(--chart-3)" /></BarChart></ResponsiveContainer></div>
      </Card>
      <Card title="Building blocks" hint="Kinds of code units found: functions, classes, routes…">
        <div className="h-56"><ResponsiveContainer><PieChart><Pie data={kinds} dataKey="value" nameKey="name" outerRadius={80} label={(e: { name: string; value: number }) => `${e.name} ${e.value}`} fontSize={11}>{kinds.map((_, i) => <Cell key={i} fill={COLORS[(i + 2) % COLORS.length]} />)}</Pie><Tooltip {...tip} /></PieChart></ResponsiveContainer></div>
      </Card>
    </div>
  );
}

function TreeCell(props: { x?: number; y?: number; width?: number; height?: number; name?: string; index?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, name = "", index = 0 } = props;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={COLORS[index % COLORS.length]} fillOpacity={0.75} stroke="var(--background)" strokeWidth={2} />
      {width > 60 && height > 18 && <text x={x + 6} y={y + 15} fontSize={11} fill="var(--background)" fontFamily="var(--font-mono)">{name.length > width / 7 ? name.slice(0, Math.floor(width / 7)) + "…" : name}</text>}
    </g>
  );
}
