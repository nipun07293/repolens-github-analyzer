import { createServerFn } from "@tanstack/react-start";

export interface AskChunk {
  path: string;
  start: number;
  end: number;
  text: string;
}
type ModelKey = "gpt" | "gemini";
const model = (m: unknown): ModelKey => (m === "gemini" ? "gemini" : "gpt");
const cleanChunks = (chunks: AskChunk[], max: number) => {
  if (!Array.isArray(chunks) || chunks.length > max) throw new Error("Invalid context.");
  return chunks.map((c) => ({ path: String(c.path), start: Number(c.start), end: Number(c.end), text: String(c.text).slice(0, 6000) }));
};

const INSTRUCTIONS = `You are RepoLens, a senior engineer explaining a codebase.
Answer ONLY from the provided code excerpts. Every claim must cite a source as [path:start-end] using the exact ranges given.
Structure: 1) a direct answer, 2) "Execution path" as a numbered list of steps (entry point -> functions -> data access), 3) "Related files", 4) "Tests" if any appear.
Label the execution path as statically inferred, not verified at runtime.
If the excerpts don't contain the answer, say so plainly and suggest what to search for. Be concise. Use markdown.`;

export const askRepo = createServerFn({ method: "POST" })
  .inputValidator((input: { question: string; repo: string; sha: string; chunks: AskChunk[]; symbols: string; model?: ModelKey }) => {
    if (!input?.question || input.question.length > 1000) throw new Error("Question must be 1–1000 characters.");
    return { ...input, model: model(input.model), symbols: String(input.symbols ?? "").slice(0, 6000), chunks: cleanChunks(input.chunks, 12) };
  })
  .handler(async ({ data }) => {
    const { runModel } = await import("./ai.server");
    const context = data.chunks.map((c) => `--- [${c.path}:${c.start}-${c.end}] ---\n${c.text}`).join("\n\n");
    const prompt = `Repository: ${data.repo} @ commit ${data.sha}\n\nRelevant symbols:\n${data.symbols}\n\nCode excerpts:\n${context}\n\nQuestion: ${data.question}`;
    const r = await runModel(data.model, INSTRUCTIONS, prompt);
    return { answer: r.text, model: r.model, ms: r.ms };
  });

const EXPLAIN = `You are RepoLens, explaining a software project to someone who may NOT be a programmer.
Write markdown with these exact sections (use ## headings):
## In one sentence
## What problem it solves
## Who would use it
## How it works (simple analogy)  — an everyday analogy, then 3-5 plain steps
## Tech stack explained — bullet each technology with a one-line plain meaning
## How to run it — numbered steps inferred from manifests/README; say if unclear
## Project map — the most important folders/files and what each is for, cite as [path:1-1]
## Strengths & risks — use the health score and findings given
## Glossary — 5-8 jargon words used above, defined simply
## Ideas to improve — 3 concrete suggestions
Be warm, clear and concrete. Only state facts supported by the input; say "likely" when inferring.`;

export const explainRepo = createServerFn({ method: "POST" })
  .inputValidator((input: { repo: string; facts: string; readme: string; level: "beginner" | "developer"; model?: ModelKey }) => ({
    repo: String(input.repo).slice(0, 200),
    facts: String(input.facts ?? "").slice(0, 8000),
    readme: String(input.readme ?? "").slice(0, 10000),
    level: input.level === "developer" ? "developer" : "beginner",
    model: model(input.model),
  }))
  .handler(async ({ data }) => {
    const { runModel } = await import("./ai.server");
    const tone = data.level === "developer" ? "The reader is an experienced developer: be technical and precise, keep the sections." : "The reader is a complete beginner: avoid jargon or explain it immediately.";
    const r = await runModel(data.model, `${EXPLAIN}\n${tone}`, `Repository: ${data.repo}\n\nAnalyzer facts:\n${data.facts}\n\nREADME:\n${data.readme || "(none)"}`);
    return { answer: r.text, model: r.model, ms: r.ms };
  });

const AGENT = `You are RepoLens Investigator, an autonomous code-investigation agent.
You solve the user's GOAL by calling tools over a GitHub repository, one tool per turn, then giving a final report.
Tools:
- search {"query": string}            BM25 keyword search over code; returns top excerpts with path:line ranges
- read {"path": string, "start"?: number} read ~60 lines of a file
- symbol {"name": string}             find where a function/class/route is defined
- impact {"path": string}             list files that transitively depend on a file (blast radius)
- findings {"path"?: string}          static-analysis findings (security/bug-risk) overall or for one file
- answer {"report": string}           finish with a markdown report
Reply with ONLY one JSON object: {"thought": "<one short sentence on why>", "tool": "<name>", "args": {...}}.
Rules: be efficient (aim for 3-6 tool calls), never repeat an identical call, base the report only on observations.
The final report must have: ## Verdict, ## Evidence (cite [path:start-end]), ## Execution path (statically inferred), ## Risks, ## Next steps.`;

export const agentStep = createServerFn({ method: "POST" })
  .inputValidator((input: { repo: string; goal: string; overview: string; steps: Array<{ thought: string; tool: string; args: string; observation: string }>; forceAnswer?: boolean; model?: ModelKey }) => {
    if (!input?.goal || input.goal.length > 800) throw new Error("Goal must be 1–800 characters.");
    if (!Array.isArray(input.steps) || input.steps.length > 10) throw new Error("Too many steps.");
    return {
      repo: String(input.repo).slice(0, 200),
      goal: input.goal,
      overview: String(input.overview ?? "").slice(0, 4000),
      steps: input.steps.map((s) => ({ thought: String(s.thought).slice(0, 400), tool: String(s.tool).slice(0, 20), args: String(s.args).slice(0, 400), observation: String(s.observation).slice(0, 5000) })),
      forceAnswer: !!input.forceAnswer,
      model: model(input.model),
    };
  })
  .handler(async ({ data }) => {
    const { runModel } = await import("./ai.server");
    const transcript = data.steps.map((s, i) => `STEP ${i + 1}\nthought: ${s.thought}\ncall: ${s.tool} ${s.args}\nobservation:\n${s.observation}`).join("\n\n");
    const prompt = `Repository: ${data.repo}\nRepo overview:\n${data.overview}\n\nGOAL: ${data.goal}\n\n${transcript || "(no steps yet)"}\n\n${data.forceAnswer ? "Step budget exhausted: you MUST now call the answer tool." : "Choose your next tool call."}`;
    const r = await runModel(data.model, AGENT, prompt);
    return { raw: r.text, model: r.model, ms: r.ms };
  });
