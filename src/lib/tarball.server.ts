/**
 * Fallback GitHub fetcher that avoids the REST API rate limit entirely:
 * streams the repo tarball from codeload.github.com, gunzips it with the
 * Web Streams DecompressionStream (works on Cloudflare Workers) and parses
 * the tar format by hand. Stops early on very large repositories.
 */

export interface TarEntry {
  path: string;
  size: number;
  content?: string;
}

export interface TarResult {
  sha: string | null;
  entries: TarEntry[];
  truncated: boolean;
}

class ByteReader {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number) {
    while (this.len < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value?.length) {
        this.chunks.push(value);
        this.len += value.length;
      }
    }
  }

  /** Read exactly n bytes (or fewer at EOF). */
  async read(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const take = Math.min(n, this.len);
    const out = new Uint8Array(take);
    let off = 0;
    while (off < take) {
      const c = this.chunks[0]!;
      const k = Math.min(c.length, take - off);
      out.set(c.subarray(0, k), off);
      off += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.len -= take;
    return out;
  }

  async skip(n: number) {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.len === 0) return;
      const c = this.chunks[0]!;
      const k = Math.min(c.length, left);
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
      this.len -= k;
      left -= k;
    }
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

const dec = new TextDecoder();
const str = (b: Uint8Array, s: number, l: number) => {
  const sub = b.subarray(s, s + l);
  const z = sub.indexOf(0);
  return dec.decode(z === -1 ? sub : sub.subarray(0, z));
};
const octal = (b: Uint8Array, s: number, l: number) => parseInt(str(b, s, l).trim() || "0", 8) || 0;

function parsePax(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\d+ ([^=]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export async function fetchTarball(
  owner: string,
  repo: string,
  ref: string,
  wantContent: (path: string, size: number) => boolean,
  limits = { maxBytes: 120_000_000, maxKeptBytes: 20_000_000 },
): Promise<TarResult> {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { headers: { "User-Agent": "RepoLens-AI" } });
  if (res.status === 404) throw new Error("Repository or branch not found (is it public?).");
  if (!res.ok || !res.body) throw new Error(`Could not download the repository from GitHub (status ${res.status}). Please try again.`);
  const r = new ByteReader(res.body.pipeThrough(new DecompressionStream("gzip")).getReader());

  let sha: string | null = null;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let processed = 0;
  let kept = 0;
  let truncated = false;
  const entries: TarEntry[] = [];

  try {
    for (;;) {
      const h = await r.read(512);
      if (h.length < 512 || h.every((x) => x === 0)) break;
      const size = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 48);
      const padded = Math.ceil(size / 512) * 512;
      processed += 512 + padded;
      if (processed > limits.maxBytes) {
        truncated = true;
        break;
      }

      if (type === "g" || type === "x" || type === "L") {
        const body = await r.read(size);
        await r.skip(padded - size);
        const text = dec.decode(body);
        if (type === "L") longName = text.replace(/\0+$/, "");
        else {
          const p = parsePax(text);
          if (type === "g" && p["comment"] && /^[0-9a-f]{40}$/.test(p["comment"])) sha = p["comment"];
          else pax = p;
        }
        continue;
      }

      const prefix = str(h, 345, 155);
      const rawName = pax["path"] ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
      pax = {};
      longName = null;
      const path = rawName.split("/").slice(1).join("/"); // strip "owner-repo-sha/"

      if ((type === "0" || type === "\0") && path) {
        const want = kept + size <= limits.maxKeptBytes && wantContent(path, size);
        if (want) {
          const body = await r.read(size);
          await r.skip(padded - size);
          kept += size;
          entries.push({ path, size, content: dec.decode(body) });
        } else {
          await r.skip(padded);
          entries.push({ path, size });
        }
      } else {
        await r.skip(padded);
      }
    }
  } finally {
    r.cancel();
  }
  return { sha, entries, truncated };
}
