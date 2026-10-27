<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Code analysis (symbols, import graph, findings, impact BFS, BM25 retrieval) lives as pure functions in src/lib/analyzer/core.ts with unit tests; keeps it deterministic and interview-defensible.
- GitHub fetching and AI calls run in server functions (src/lib/*.functions.ts); AI only receives retrieved excerpts so answers cite real file:line ranges.
