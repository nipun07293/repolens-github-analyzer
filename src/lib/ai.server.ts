import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

/** One-shot Responses call through Lovable AI Gateway, streamed and consumed server-side. */
export async function runResponses(instructions: string, prompt: string): Promise<string> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("AI is not configured (missing key).");
  let runId: string | undefined;
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
      const res = await fetch(input, { ...init, headers });
      runId ??= res.headers.get("X-Lovable-AIG-Run-ID") ?? undefined;
      if (!res.ok) {
        const body = await res.clone().text();
        if (res.status === 402) throw new Error("AI credits are exhausted. Add credits to keep using AI features.");
        if (res.status === 429) throw new Error("AI is rate limited right now. Please try again in a minute.");
        throw new Error(`AI request failed [${res.status}]: ${body.slice(0, 300)}`);
      }
      return res;
    },
  });
  let failure: unknown;
  const result = streamText({
    model: provider.responses("openai/gpt-6-astra"),
    instructions,
    prompt,
    onError: ({ error }) => {
      failure = error;
    },
    providerOptions: {
      openai: {
        forceReasoning: true,
        reasoningEffort: "low",
        reasoningSummary: "auto",
        store: false,
        include: ["reasoning.encrypted_content"],
      },
    },
  });
  const text = await result.text;
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  if (!text.trim()) throw new Error("The AI returned no answer for this question.");
  return text;
}
