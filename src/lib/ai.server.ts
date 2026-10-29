import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";

export type ModelKey = "gpt" | "gemini";
export const MODEL_IDS: Record<ModelKey, string> = {
  gpt: "openai/gpt-6-astra",
  gemini: "google/gemini-3-flash-preview",
};

function gatewayFetch() {
  let runId: string | undefined;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
    const res = await fetch(input, { ...init, headers });
    runId ??= res.headers.get("X-Lovable-AIG-Run-ID") ?? undefined;
    if (!res.ok) {
      const body = await res.clone().text();
      if (res.status === 402) throw new Error("AI credits are exhausted. Add credits to keep using AI features.");
      if (res.status === 429) throw new Error("AI is rate limited right now. Please try again in a minute.");
      if (res.status === 403) throw new Error(`AI access denied: ${body.slice(0, 200)}`);
      throw new Error(`AI request failed [${res.status}]: ${body.slice(0, 300)}`);
    }
    return res;
  };
}

/** One-shot call through Lovable AI Gateway (GPT via Responses, Gemini via Chat Completions), streamed and consumed server-side. */
export async function runModel(model: ModelKey, instructions: string, prompt: string): Promise<{ text: string; model: string; ms: number }> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("AI is not configured (missing key).");
  const headers = { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" };
  const t0 = Date.now();
  let failure: unknown;
  const onError = ({ error }: { error: unknown }) => {
    failure = error;
  };
  let result;
  if (model === "gemini") {
    const provider = createOpenAICompatible({ name: "lovable", baseURL: "https://ai.gateway.lovable.dev/v1", apiKey, headers, fetch: gatewayFetch() });
    result = streamText({ model: provider(MODEL_IDS.gemini), system: instructions, prompt, onError });
  } else {
    const provider = createOpenAI({ baseURL: "https://ai.gateway.lovable.dev/v1", apiKey, headers, fetch: gatewayFetch() });
    result = streamText({
      model: provider.responses(MODEL_IDS.gpt),
      instructions,
      prompt,
      onError,
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", store: false, include: ["reasoning.encrypted_content"] },
      },
    } as Parameters<typeof streamText>[0]);
  }
  const text = await result.text;
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  if (!text.trim()) throw new Error("The AI returned no answer.");
  return { text, model: MODEL_IDS[model], ms: Date.now() - t0 };
}

/** Back-compat helper. */
export async function runResponses(instructions: string, prompt: string): Promise<string> {
  return (await runModel("gpt", instructions, prompt)).text;
}
