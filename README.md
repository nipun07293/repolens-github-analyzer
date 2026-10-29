# RepoLens AI — Agentic Codebase Intelligence

Paste any public GitHub repository (or a profile, to pick one) and RepoLens explains it from beginner to expert level.

## Features
| Tab | What it does |
| --- | --- |
| Overview | Stats, health score (A–F), languages, detected stack, core modules, API routes, deps, tests & CI |
| Explain (simple) | AI-written plain-language guide: purpose, analogy, how to run, project map, glossary — beginner or developer mode |
| Insights | Recharts dashboards: health radar, language donut, folder treemap, findings by severity, largest & most-coupled files |
| Symbols | Every function / class / route with file:line |
| Graph | Interactive React Flow import graph |
| Findings | Static rules (eval, secrets, SQL concat, XSS, shell exec, empty catch…) + Tarjan import-cycle detection |
| Impact | Reverse-BFS "blast radius" for changing a file |
| Ask AI | BM25 retrieval → cited answers with clickable `[path:start-end]` sources; choose **GPT** or **Gemini** |
| Agent | ReAct-style investigator: the LLM plans and calls real tools (search, read, symbol, impact, findings), with a live step timeline and a cited final report. Playbooks: security audit, request trace, onboarding tour, bug hunt, refactor plan |

## Architecture
```text
Browser (React 19, TanStack Router/Query, Tailwind, Recharts, React Flow)
  │  deterministic analysis in src/lib/analyzer/core.ts (pure, unit-tested)
  │  agent tools execute client-side against the fetched snapshot
  ▼
TanStack Start server functions (Cloudflare Workers runtime)
  ├─ repo.functions.ts  → GitHub REST + raw content (bounded-concurrency pool)
  └─ ask.functions.ts   → Lovable AI Gateway (GPT via Responses API, Gemini via Chat Completions)
```
CS concepts: regex-based symbol extraction, import resolution, graph BFS (impact), Tarjan SCC (cycles), BM25 ranking, worker pool, weighted health scoring, ReAct agent loop with step budget and duplicate-call guard.

## Run locally
```bash
bun install
echo "LOVABLE_API_KEY=your_key" > .env   # needed for AI tabs only
bun run dev
bunx vitest run                          # analyzer unit tests
```

## Deploy
- **Easiest:** click **Publish** in Lovable (server functions + AI work out of the box).
- **GitHub:** connect via Lovable → Project settings → Git; every change syncs to your repo.
- **Self-host (Cloudflare Workers):** `bun run build` then deploy the output with Wrangler and set `LOVABLE_API_KEY` as a secret.
- Netlify requires switching the Nitro preset to `netlify` and setting `LOVABLE_API_KEY` in site env vars.
