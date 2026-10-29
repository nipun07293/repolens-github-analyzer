import { describe, it, expect } from "vitest";
import { parseRepoUrl, extractSymbols, buildGraph, impactOf, findCycles, detectFindings, bm25Search, chunkFiles } from "./core";

const f = (path: string, content: string) => ({ path, content, size: content.length });

describe("analyzer", () => {
  it("parses GitHub URLs and rejects others", () => {
    expect(parseRepoUrl("https://github.com/vercel/ms")).toEqual({ owner: "vercel", repo: "ms" });
    expect(parseRepoUrl("vercel/ms.git")).toEqual({ owner: "vercel", repo: "ms" });
    expect(parseRepoUrl("https://evil.com/a/b")).toBeNull();
  });

  it("extracts symbols with line numbers", () => {
    const s = extractSymbols(f("a.ts", "export function login() {}\nclass User {}\napp.post('/api/pay', h)"));
    expect(s.map((x) => [x.name, x.kind, x.line])).toEqual([["login", "function", 1], ["User", "class", 2], ["/api/pay", "route", 3]]);
  });

  it("computes transitive change impact via reverse BFS", () => {
    const files = [f("src/db.ts", ""), f("src/user.ts", "import {q} from './db'"), f("src/api.ts", "import u from './user'"), f("src/api.test.ts", "import a from './api'")];
    const { edges } = buildGraph(files);
    expect(impactOf("src/db.ts", edges).map((x) => [x.path, x.depth])).toEqual([["src/user.ts", 1], ["src/api.ts", 2], ["src/api.test.ts", 3]]);
  });

  it("detects import cycles", () => {
    const { edges } = buildGraph([f("a.ts", "import './b'"), f("b.ts", "import './a'"), f("c.ts", "")]);
    expect(findCycles(edges)[0]!.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("flags SQL concatenation as high severity", () => {
    const r = detectFindings(f("q.js", 'db.query("SELECT * FROM users WHERE id=" + id)'));
    expect(r.find((x) => x.rule === "sql-concat")?.severity).toBe("high");
  });

  it("ranks relevant chunk first", () => {
    const top = bm25Search(chunkFiles([f("auth.ts", "function verifyPassword(){}"), f("math.ts", "function add(){}")]), "where is password verified");
    expect(top[0]!.path).toBe("auth.ts");
  });
});

import { healthScore, dirStats, extractJson } from "./core";
describe("health & helpers", () => {
  it("scores a clean, tested repo highly and a risky one low", () => {
    const clean = healthScore({ findings: [], loc: 2000, files: 10, testFiles: 3, cycles: 0, edges: 12 });
    expect(clean.overall).toBe(100);
    expect(clean.grade).toBe("A");
    const hi = { rule: "eval-usage", severity: "high" as const, category: "security" as const, path: "a.js", line: 1, message: "", snippet: "" };
    const risky = healthScore({ findings: Array(10).fill(hi), loc: 1000, files: 10, testFiles: 0, cycles: 2, edges: 5 });
    expect(risky.parts.security).toBe(0);
    expect(risky.parts.testing).toBe(0);
    expect(risky.overall).toBeLessThan(55);
  });
  it("groups lines by folder", () => {
    expect(dirStats([f("src/a.ts", "1\n2"), f("src/b.ts", "1"), f("x.ts", "1")])).toEqual([{ dir: "src", files: 2, lines: 3 }, { dir: "(root)", files: 1, lines: 1 }]);
  });
  it("extracts JSON from fenced LLM output", () => {
    expect(extractJson('sure:\n```json\n{"action":"read","input":"a {b}"}\n```')).toEqual({ action: "read", input: "a {b}" });
    expect(extractJson("no json")).toBeNull();
  });
});
