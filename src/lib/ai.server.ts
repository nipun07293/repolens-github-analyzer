import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";

export type ModelKey = "gpt" | "gemini";
export const MODEL_IDS: Record<ModelKey, string> = {
  gpt: "openai/gpt-6-astra",
  gemini: "google/gemini-3-flash-preview",
};

/** Gateway fetch that keeps one run id and remembers the real HTTP failure (the AI SDK otherwise hides it behind "No output generated"). */
function gatewayFetch(state: { error?: Error }) {
  let runId: string | undefined;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
    const res = await fetch(input, { ...init, headers });
    runId ??= res.headers.get("X-Lovable-AIG-Run-ID") ?? undefined;
    if (!res.ok) {
      const body = await res.clone().text();
      let msg = "";
      try {
        msg = (JSON.parse(body) as { message?: string }).message ?? "";
      } catch { /* not json */ }
      if (res.status === 402) state.error = new Error("AI credits are used up for this workspace. Add credits in Lovable (Settings → Plans & credits) and try again.");
      else if (res.status === 429) state.error = new Error("AI is rate limited right now. Please try again in a minute.");
      else if (res.status === 403) state.error = new Error(`AI access denied: ${msg || body.slice(0, 200)}`);
      else state.error = new Error(`AI request failed [${res.status}]: ${msg || body.slice(0, 300)}`);
      throw state.error;
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
  const state: { error?: Error } = {};
  let failure: unknown;
  const onError = ({ error }: { error: unknown }) => {
    failure = error;
  };
  let result;
  if (model === "gemini") {
    const provider = createOpenAICompatible({ name: "lovable", baseURL: "https://ai.gateway.lovable.dev/v1", apiKey, headers, fetch: gatewayFetch(state) });
    result = streamText({ model: provider(MODEL_IDS.gemini), system: instructions, prompt, onError, maxRetries: 0 });
  } else {
    const provider = createOpenAI({ baseURL: "https://ai.gateway.lovable.dev/v1", apiKey, headers, fetch: gatewayFetch(state) });
    result = streamText({
      model: provider.responses(MODEL_IDS.gpt),
      instructions,
      prompt,
      onError,
      maxRetries: 0,
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", store: false, include: ["reasoning.encrypted_content"] },
      },
    } as Parameters<typeof streamText>[0]);
  }
  let text = "";
  try {
    text = await result.text;
  } catch (e) {
    throw state.error ?? (failure instanceof Error ? failure : e);
  }
  if (state.error) throw state.error;
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  if (!text.trim()) throw new Error("The AI returned no answer.");
  return { text, model: MODEL_IDS[model], ms: Date.now() - t0 };
}

/** Back-compat helper. */
export async function runResponses(instructions: string, prompt: string): Promise<string> {
  return (await runModel("gpt", instructions, prompt)).text;
}
