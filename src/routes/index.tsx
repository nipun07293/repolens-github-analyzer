import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { parseRepoUrl } from "@/lib/analyzer/core";
import { listUserRepos } from "@/lib/repo.functions";

function parseUser(input: string): string | null {
  const m = input.trim().replace(/\/+$/, "").match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})$/) ?? input.trim().match(/^@?([A-Za-z0-9-]{1,39})$/);
  return m?.[1] ?? null;
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RepoLens AI — Codebase intelligence for GitHub repos" },
      { name: "description", content: "Paste a GitHub repo. Get its architecture, dependency graph, static-analysis findings, change impact and cited AI answers." },
      { property: "og:title", content: "RepoLens AI — Codebase intelligence" },
      { property: "og:description", content: "Understand codebases, trace features, detect bugs and predict change impact." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const EXAMPLES = ["expressjs/express", "pallets/flask", "vercel/ms", "tiangolo/fastapi"];

function Index() {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const navigate = useNavigate();
  const listRepos = useServerFn(listUserRepos);
  const [user, setUser] = useState<{ name: string; repos: Awaited<ReturnType<typeof listUserRepos>> } | null>(null);
  const [loading, setLoading] = useState(false);
  const go = async (u: string) => {
    const p = parseRepoUrl(u);
    if (!p) {
      const name = parseUser(u);
      if (!name) return setErr("Enter a GitHub repo like github.com/owner/repo, or a profile like github.com/owner");
      setLoading(true);
      setUser(null);
      try {
        const repos = await listRepos({ data: { user: name } });
        if (!repos.length) setErr(`${name} has no public repositories.`);
        else setUser({ name, repos });
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
      return;
    }
    navigate({ to: "/analyze", search: { repo: `${p.owner}/${p.repo}` } });
  };
  return (
    <main className="bg-grid min-h-screen">
      <div className="mx-auto max-w-4xl px-6 pt-28 pb-16">
        <p className="font-mono text-sm text-primary">$ repolens analyze --deep</p>
        <h1 className="mt-4 text-5xl font-bold leading-tight md:text-7xl">
          See through any<br />codebase.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Trace features, map dependencies, catch risky code and predict what breaks when you change a file — every answer cited to exact lines and commit.
        </p>
        <form
          className="mt-10 flex flex-col gap-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            go(url);
          }}
        >
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setErr("");
            }}
            placeholder="github.com/owner/repo or github.com/owner"
            className="flex-1 rounded-md border border-input bg-card px-4 py-3 font-mono text-sm outline-none focus:border-primary"
          />
          <button className="glow-primary rounded-md bg-primary px-6 py-3 font-semibold text-primary-foreground hover:opacity-90">Analyze repo</button>
        </form>
        {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
        {loading && <p className="mt-2 animate-pulse font-mono text-sm text-muted-foreground">› listing repositories…</p>}
        {user && (
          <div className="mt-4 rounded-lg border border-border bg-card p-3">
            <p className="px-2 pb-2 text-sm text-muted-foreground">That's a profile — pick one of <span className="text-foreground">{user.name}</span>'s repositories:</p>
            <ul className="max-h-80 overflow-auto">
              {user.repos.map((r) => (
                <li key={r.name}>
                  <button onClick={() => go(`${user.name}/${r.name}`)} className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-muted">
                    <span className="font-mono text-sm text-primary">{r.name}</span>
                    {r.fork && <span className="text-xs text-muted-foreground">fork</span>}
                    <span className="truncate text-xs text-muted-foreground">{r.description}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{r.language} ★{r.stars}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-xs">
          <span className="text-muted-foreground">try:</span>
          {EXAMPLES.map((e) => (
            <button key={e} onClick={() => go(e)} className="rounded border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-primary">
              {e}
            </button>
          ))}
        </div>
        <div className="mt-24 grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3">
          {[
            ["Knowledge graph", "Imports resolved into a dependency graph with cycle detection (Tarjan SCC)."],
            ["Change impact", "Reverse BFS shows every file and test transitively affected by an edit."],
            ["Cited answers", "BM25 retrieval feeds AI only real excerpts; answers cite file:line ranges."],
          ].map(([t, d]) => (
            <div key={t} className="bg-card p-6">
              <h3 className="font-semibold text-primary">{t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
