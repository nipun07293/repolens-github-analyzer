import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { GraphEdge } from "@/lib/analyzer/core";

export default function GraphView({ edges, highlight, onSelect }: { edges: GraphEdge[]; highlight?: Set<string>; onSelect: (p: string) => void }) {
  const { nodes, flowEdges } = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const top = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 90).map(([p]) => p);
    const keep = new Set(top);
    const byDir = new Map<string, string[]>();
    for (const p of top) {
      const d = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d)!.push(p);
    }
    const nodes: Node[] = [];
    [...byDir.entries()].sort().forEach(([dir, ps], col) => {
      ps.forEach((p, row) => {
        const hi = highlight?.has(p);
        nodes.push({
          id: p,
          position: { x: col * 230, y: row * 60 },
          data: { label: p.split("/").pop() },
          style: {
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            background: hi ? "var(--primary)" : "var(--card)",
            color: hi ? "var(--primary-foreground)" : "var(--foreground)",
            border: "1px solid var(--border)",
            width: 200,
          },
          title: dir,
        } as Node);
      });
    });
    const flowEdges: Edge[] = edges
      .filter((e) => keep.has(e.from) && keep.has(e.to))
      .map((e, i) => ({ id: `${i}`, source: e.from, target: e.to, animated: e.kind === "TESTS", style: { stroke: e.kind === "TESTS" ? "var(--accent)" : "var(--muted-foreground)", opacity: 0.5 } }));
    return { nodes, flowEdges };
  }, [edges, highlight]);

  if (!nodes.length) return <p className="p-8 text-muted-foreground">No internal imports resolved for this repository.</p>;
  return (
    <div className="h-[640px] rounded-lg border border-border">
      <ReactFlow nodes={nodes} edges={flowEdges} fitView onNodeClick={(_, n) => onSelect(n.id)} colorMode="dark" minZoom={0.1}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
