import { createServerFn } from "@tanstack/react-start";

export interface AskChunk {
  path: string;
  start: number;
  end: number;
  text: string;
}

const INSTRUCTIONS = `You are RepoLens, a senior engineer explaining a codebase.
Answer ONLY from the provided code excerpts. Every claim must cite a source as [path:start-end] using the exact ranges given.
Structure: 1) a direct answer, 2) "Execution path" as a numbered list of steps (entry point -> functions -> data access), 3) "Related files", 4) "Tests" if any appear.
Label the execution path as statically inferred, not verified at runtime.
If the excerpts don't contain the answer, say so plainly and suggest what to search for. Be concise. Use markdown.`;

export const askRepo = createServerFn({ method: "POST" })
  .inputValidator((input: { question: string; repo: string; sha: string; chunks: AskChunk[]; symbols: string }) => {
    if (!input?.question || input.question.length > 1000) throw new Error("Question must be 1–1000 characters.");
    if (!Array.isArray(input.chunks) || input.chunks.length > 12) throw new Error("Invalid context.");
    return {
      ...input,
      symbols: String(input.symbols ?? "").slice(0, 6000),
      chunks: input.chunks.map((c) => ({ path: String(c.path), start: Number(c.start), end: Number(c.end), text: String(c.text).slice(0, 6000) })),
    };
  })
  .handler(async ({ data }) => {
    const { runResponses } = await import("./ai.server");
    const context = data.chunks.map((c) => `--- [${c.path}:${c.start}-${c.end}] ---\n${c.text}`).join("\n\n");
    const prompt = `Repository: ${data.repo} @ commit ${data.sha}\n\nRelevant symbols:\n${data.symbols}\n\nCode excerpts:\n${context}\n\nQuestion: ${data.question}`;
    return { answer: await runResponses(INSTRUCTIONS, prompt) };
  });
