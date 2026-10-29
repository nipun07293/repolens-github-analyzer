type OpenFn = (o: { path: string; line?: number | undefined }) => void;

/** Minimal markdown renderer that turns [path:start-end] citations into clickable code links. */
export function Markdown({ text, onOpen }: { text: string; onOpen: OpenFn }) {
  return (
    <div className="mt-4 space-y-1.5 text-sm leading-relaxed">
      {text.split("\n").map((line, i) => {
        const h = line.match(/^#{1,4}\s+(.*)/);
        const li = !h && line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
        const body = (h ? h[1] : li ? li[1] : line) ?? "";
        const content = body.split(/(\[[^\]\s]+:\d+(?:-\d+)?\]|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => {
          const c = part.match(/^\[([^\]\s]+):(\d+)(?:-\d+)?\]$/);
          if (c && c[1] && c[2]) return <button key={j} onClick={() => onOpen({ path: c[1]!, line: Number(c[2]) })} className="mx-0.5 rounded bg-muted px-1 font-mono text-xs text-primary hover:underline">{c[1].split("/").pop()}:{c[2]}</button>;
          if (part.startsWith("**")) return <strong key={j}>{part.slice(2, -2)}</strong>;
          if (part.startsWith("`")) return <code key={j} className="rounded bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
          return part;
        });
        if (h) return <h3 key={i} className="pt-3 font-semibold text-primary">{content}</h3>;
        if (li) return <p key={i} className="flex gap-2 pl-2"><span className="text-accent">›</span><span>{content}</span></p>;
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i}>{content}</p>;
      })}
    </div>
  );
}

export function ModelPicker({ value, onChange }: { value: "gpt" | "gemini"; onChange: (m: "gpt" | "gemini") => void }) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
      {(["gpt", "gemini"] as const).map((m) => (
        <button key={m} type="button" onClick={() => onChange(m)} className={`rounded px-3 py-1 ${value === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {m === "gpt" ? "GPT" : "Gemini"}
        </button>
      ))}
    </div>
  );
}
