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
  /** "api" = GitHub REST API, "archive" = rate-limit-free tarball fallback (no stars/forks metadata). */
  source: "api" | "archive";
}

const MAX_FILES = 160;
const MAX_BYTES = 80_000;
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "pom.xml", "build.gradle", "go.mod", "Gemfile", "Dockerfile", "docker-compose.yml"];
const IGNORED_DIR = /(^|\/)(node_modules|vendor|dist|build|\.git|\.next|coverage)\//;
const LANG_NAME: Record<string, string> = { ts: "TypeScript", js: "JavaScript", py: "Python", java: "Java", go: "Go", rb: "Ruby" };

class GitHubLimitError extends Error {}

/** GitHub REST call. Uses the GitHub connector (5,000 req/h) when linked, otherwise anonymous (60 req/h per shared IP). */
async function gh(path: string) {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const ghKey = process.env["GITHUB_API_KEY"];
  const viaGateway = !!(lovableKey && ghKey);
  const res = await fetch(viaGateway ? `https://connector-gateway.lovable.dev/github/${path}` : `https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "RepoLens-AI",
      ...(viaGateway ? { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": ghKey! } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) throw new Error("Repository or branch not found (is it public?).");
    if (res.status === 403 || res.status === 429) throw new GitHubLimitError("GitHub rate limit reached.");
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

const isCandidate = (path: string, size: number) => langOf(path) !== "other" && size <= MAX_BYTES && !IGNORED_DIR.test(path) && !/\.min\.js$|\.d\.ts$/.test(path);
const isManifest = (path: string) => MANIFESTS.includes(path) || /^readme(\.md|\.rst|\.txt)?$/i.test(path);

// Per-isolate cache so repeat visits don't spend GitHub quota.
const cache = new Map<string, { at: number; snap: RepoSnapshot }>();
const CACHE_MS = 15 * 60_000;

async function viaApi(owner: string, repo: string, wanted?: string): Promise<RepoSnapshot> {
  const t0 = Date.now();
  const meta = await gh(`repos/${owner}/${repo}`);
  const branch = wanted || meta.default_branch;
  const [commit, languages] = await Promise.all([gh(`repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`), gh(`repos/${owner}/${repo}/languages`)]);
  const sha: string = commit.sha;
  const tree = await gh(`repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  const blobs = (tree.tree as Array<{ path: string; type: string; size?: number }>).filter((t) => t.type === "blob");
  const allPaths = blobs.map((b) => b.path).filter((p) => !IGNORED_DIR.test(p));
  const candidates = blobs.filter((b) => isCandidate(b.path, b.size ?? 0)).sort((a, b) => priority(b.path) - priority(a.path));
  const chosen = candidates.slice(0, MAX_FILES);
  const raw = (p: string) => fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`).then((r) => (r.ok ? r.text() : ""));
  const contents = await pool(chosen, 12, (b) => raw(b.path));
  const files = chosen.map((b, i) => ({ path: b.path, content: contents[i] ?? "", size: b.size ?? (contents[i] ?? "").length })).filter((f) => f.content);
  const manifestPaths = allPaths.filter(isManifest);
  const manifestContents = await pool(manifestPaths, 6, raw);
  const manifests: Record<string, string> = {};
  manifestPaths.forEach((p, i) => (manifests[p] = (manifestContents[i] ?? "").slice(0, 20_000)));
  return {
    owner, repo, branch, sha,
    description: meta.description, stars: meta.stargazers_count, forks: meta.forks_count,
    license: meta.license?.spdx_id ?? null, defaultBranch: meta.default_branch,
    languages, totalFiles: allPaths.length, allPaths: allPaths.slice(0, 5000),
    files, skipped: candidates.length - files.length, fetchMs: Date.now() - t0, manifests, source: "api",
  };
}

/** Rate-limit-free path: one tarball download from codeload.github.com, parsed in the worker. */
async function viaArchive(owner: string, repo: string, wanted?: string): Promise<RepoSnapshot> {
  const t0 = Date.now();
  const { fetchTarball } = await import("./tarball.server");
  const tar = await fetchTarball(owner, repo, wanted || "HEAD", (p, size) => isCandidate(p, size) || isManifest(p));
  const blobs = tar.entries.filter((e) => !IGNORED_DIR.test(e.path));
  const allPaths = blobs.map((b) => b.path);
  const candidates = blobs.filter((b) => isCandidate(b.path, b.size)).sort((a, b) => priority(b.path) - priority(a.path));
  const files = candidates.slice(0, MAX_FILES).filter((b) => b.content).map((b) => ({ path: b.path, content: b.content!, size: b.size }));
  const manifests: Record<string, string> = {};
  for (const b of blobs) if (isManifest(b.path) && b.content) manifests[b.path] = b.content.slice(0, 20_000);
  const languages: Record<string, number> = {};
  for (const b of blobs) {
    const l = LANG_NAME[langOf(b.path)];
    if (l) languages[l] = (languages[l] ?? 0) + b.size;
  }
  const branch = wanted || "default";
  return {
    owner, repo, branch, sha: tar.sha ?? "unknown",
    description: null, stars: 0, forks: 0, license: null, defaultBranch: branch,
    languages, totalFiles: allPaths.length, allPaths: allPaths.slice(0, 5000),
    files, skipped: candidates.length - files.length, fetchMs: Date.now() - t0, manifests, source: "archive",
  };
}

export const analyzeRepo = createServerFn({ method: "POST" })
  .inputValidator((input: { url: string; branch?: string; fresh?: boolean }) => {
    if (typeof input?.url !== "string" || input.url.length > 300) throw new Error("Invalid URL");
    if (input.branch && !/^[\w./-]{1,100}$/.test(input.branch)) throw new Error("Invalid branch");
    return input;
  })
  .handler(async ({ data }): Promise<RepoSnapshot> => {
    const parsed = parseRepoUrl(data.url);
    if (!parsed) throw new Error("Please enter a valid GitHub repository URL, e.g. github.com/owner/repo");
    const { owner, repo } = parsed;
    const key = `${owner}/${repo}@${data.branch ?? ""}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && !data.fresh && Date.now() - hit.at < CACHE_MS) return hit.snap;
    let snap: RepoSnapshot;
    try {
      snap = await viaApi(owner, repo, data.branch);
    } catch (e) {
      if (!(e instanceof GitHubLimitError)) throw e;
      snap = await viaArchive(owner, repo, data.branch);
    }
    cache.set(key, { at: Date.now(), snap });
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
    return snap;
  });

export const listUserRepos = createServerFn({ method: "POST" })
  .inputValidator((input: { user: string }) => {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(input?.user ?? "")) throw new Error("Invalid GitHub username");
    return input;
  })
  .handler(async ({ data }) => {
    try {
      const repos = (await gh(`users/${data.user}/repos?per_page=100&sort=updated`)) as Array<{ name: string; description: string | null; language: string | null; stargazers_count: number; fork: boolean }>;
      return repos.map((r) => ({ name: r.name, description: r.description, language: r.language, stars: r.stargazers_count, fork: r.fork }));
    } catch (e) {
      if (e instanceof GitHubLimitError)
        throw new Error(`GitHub is limiting profile lookups right now. Paste a full project link instead, e.g. github.com/${data.user}/<project-name>.`);
      throw e;
    }
  });
