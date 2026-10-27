import { createServerFn } from "@tanstack/react-start";
import { parseRepoUrl, langOf, type SourceFile } from "./analyzer/core";

export interface RepoSnapshot {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  description: string | null;
  stars: number;
  forks: number;
  license: string | null;
  defaultBranch: string;
  languages: Record<string, number>;
  totalFiles: number;
  allPaths: string[];
  files: SourceFile[];
  skipped: number;
  fetchMs: number;
  manifests: Record<string, string>;
}

const MAX_FILES = 160;
const MAX_BYTES = 80_000;
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "pom.xml", "build.gradle", "go.mod", "Gemfile", "Dockerfile", "docker-compose.yml"];

async function gh(path: string) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RepoLens-AI" },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) throw new Error("Repository or branch not found (is it public?).");
    if (res.status === 403 || res.status === 429) throw new Error("GitHub rate limit reached. Please wait a few minutes and try again.");
    throw new Error(`GitHub error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Bounded-concurrency worker pool (like a fixed-size thread pool). */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function priority(path: string): number {
  let p = 0;
  if (/(^|\/)(src|app|lib|server|api|pkg|cmd|internal)\//.test(path)) p += 3;
  if (/(index|main|app|server|routes?|auth|db|models?|controller|service)\./i.test(path)) p += 2;
  if (/test|spec/i.test(path)) p += 1;
  p -= path.split("/").length * 0.2;
  return p;
}

export const analyzeRepo = createServerFn({ method: "POST" })
  .inputValidator((input: { url: string; branch?: string }) => {
    if (typeof input?.url !== "string" || input.url.length > 300) throw new Error("Invalid URL");
    if (input.branch && !/^[\w./-]{1,100}$/.test(input.branch)) throw new Error("Invalid branch");
    return input;
  })
  .handler(async ({ data }): Promise<RepoSnapshot> => {
    const parsed = parseRepoUrl(data.url);
    if (!parsed) throw new Error("Please enter a valid GitHub repository URL, e.g. github.com/owner/repo");
    const t0 = Date.now();
    const { owner, repo } = parsed;
    const meta = await gh(`repos/${owner}/${repo}`);
    const branch = data.branch || meta.default_branch;
    const [commit, languages] = await Promise.all([
      gh(`repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`),
      gh(`repos/${owner}/${repo}/languages`),
    ]);
    const sha: string = commit.sha;
    const tree = await gh(`repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const blobs = (tree.tree as Array<{ path: string; type: string; size?: number }>).filter((t) => t.type === "blob");
    const allPaths = blobs.map((b) => b.path).filter((p) => !/(^|\/)(node_modules|vendor|dist|build|\.git)\//.test(p));
    const candidates = blobs
      .filter((b) => langOf(b.path) !== "other" && (b.size ?? 0) <= MAX_BYTES && !/(^|\/)(node_modules|vendor|dist|build|\.next|coverage)\//.test(b.path) && !/\.min\.js$|\.d\.ts$/.test(b.path))
      .sort((a, b) => priority(b.path) - priority(a.path));
    const chosen = candidates.slice(0, MAX_FILES);
    const raw = (p: string) => fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`).then((r) => (r.ok ? r.text() : ""));
    const contents = await pool(chosen, 12, (b) => raw(b.path));
    const files = chosen.map((b, i) => ({ path: b.path, content: contents[i] ?? "", size: b.size ?? (contents[i] ?? "").length })).filter((f) => f.content);
    const manifestPaths = allPaths.filter((p) => MANIFESTS.includes(p));
    const manifestContents = await pool(manifestPaths, 6, raw);
    const manifests: Record<string, string> = {};
    manifestPaths.forEach((p, i) => (manifests[p] = (manifestContents[i] ?? "").slice(0, 20_000)));
    return {
      owner, repo, branch, sha,
      description: meta.description, stars: meta.stargazers_count, forks: meta.forks_count,
      license: meta.license?.spdx_id ?? null, defaultBranch: meta.default_branch,
      languages, totalFiles: allPaths.length, allPaths: allPaths.slice(0, 5000),
      files, skipped: candidates.length - files.length, fetchMs: Date.now() - t0, manifests,
    };
  });
