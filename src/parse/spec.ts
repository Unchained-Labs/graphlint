/**
 * Front-end for declarative GraphSpec files (`.graph.json`, `.spec.json`).
 *
 * A spec is the graph as data: diffable, lintable, and safe for a model to
 * generate because a validator runs before a token is spent. This front-end is
 * much simpler than the script one — everything is already explicit, so the work
 * is validation rather than inference.
 */
import type { Cycle, Graph, GraphEdge, GraphMeta, GraphNode, Loc, Tier } from "../types.js";

interface RawNode {
  id?: unknown;
  tier?: unknown;
  model?: unknown;
  phase?: unknown;
  schema?: unknown;
  outputSchema?: unknown;
  isolation?: unknown;
  writes?: unknown;
  tools?: unknown;
  fanout?: { over?: unknown; maxConcurrent?: unknown; width?: unknown };
  harness?: { kind?: unknown; lenses?: unknown; passIf?: unknown; model?: unknown };
}

interface RawEdge {
  from?: unknown;
  to?: unknown;
  channel?: unknown;
  schema?: unknown;
  barrier?: unknown;
  barrierReason?: unknown;
}

interface RawSpec {
  name?: unknown;
  description?: unknown;
  budget?: { tokens?: unknown; usd?: unknown };
  phases?: unknown;
  nodes?: RawNode[];
  edges?: RawEdge[];
}

const TIERS = new Set<Tier>(["cheap", "standard", "deep"]);

export function parseSpec(file: string, source: string): Graph {
  const warnings: string[] = [];
  let raw: RawSpec;
  try {
    raw = JSON.parse(source) as RawSpec;
  } catch (e) {
    throw Object.assign(new Error(`${file}: ${(e as Error).message}`), {
      graphlintParseError: true,
    });
  }

  /** Locate a key in the raw JSON text so findings point at a real line. */
  const lines = source.split("\n");
  const find = (needle: string, from = 0): Loc => {
    for (let i = from; i < lines.length; i++) {
      const col = lines[i]!.indexOf(needle);
      if (col !== -1) {
        return { file, line: i + 1, column: col, text: lines[i]!.trim() };
      }
    }
    return { file, line: 1, column: 0, text: lines[0]?.trim() };
  };

  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const meta: GraphMeta = {
    present: typeof raw.name === "string",
    name: str(raw.name),
    description: str(raw.description),
    phases: Array.isArray(raw.phases) ? raw.phases.filter((p): p is string => typeof p === "string") : [],
    budget: raw.budget
      ? { tokens: num(raw.budget.tokens), usd: num(raw.budget.usd) }
      : null,
    loc: find('"name"'),
  };

  const nodes: GraphNode[] = [];
  for (const rn of raw.nodes ?? []) {
    const id = str(rn.id);
    if (!id) {
      warnings.push("a node has no `id` and was skipped");
      continue;
    }
    const nodeLoc = find(`"${id}"`);
    const tierRaw = str(rn.tier);
    const tier: Tier = tierRaw && TIERS.has(tierRaw as Tier) ? (tierRaw as Tier) : "unset";
    if (tierRaw && tier === "unset") {
      warnings.push(`node "${id}": unknown tier "${tierRaw}" (expected cheap|standard|deep)`);
    }

    const lenses = Array.isArray(rn.harness?.lenses)
      ? (rn.harness!.lenses as unknown[]).filter((l): l is string => typeof l === "string")
      : [];
    const isVerifier = Boolean(rn.harness) || /verif|judge|skeptic|lens/i.test(id);

    nodes.push({
      id,
      // A spec node's "prompt" is its harness kind — enough for the verifier rules.
      prompt: rn.harness?.kind ? `harness:${String(rn.harness.kind)}` : null,
      promptIsTemplate: false,
      phase: str(rn.phase),
      label: id,
      hasSchema: Boolean(rn.schema ?? rn.outputSchema),
      tier,
      modelLiteral: str(rn.model),
      effort: null,
      isolation: str(rn.isolation),
      agentType: null,
      fanout:
        num(rn.fanout?.width) ??
        num(rn.fanout?.maxConcurrent) ??
        (rn.fanout ? -1 : null), // -1 = fans out, width unknown statically
      loopDepth: 0,
      inCycle: false,
      isVerifier,
      loc: nodeLoc,
      // carried for the rules that need harness detail
      ...({ __lenses: lenses, __passIf: str(rn.harness?.passIf), __writes: rn.writes === true } as any),
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const re of raw.edges ?? []) {
    const from = str(re.from);
    const to = str(re.to);
    if (!from || !to) {
      warnings.push("an edge is missing `from` or `to` and was skipped");
      continue;
    }
    if (!ids.has(from)) warnings.push(`edge references unknown node "${from}"`);
    if (!ids.has(to)) warnings.push(`edge references unknown node "${to}"`);
    edges.push({
      from,
      to,
      channel: str(re.channel),
      kind: re.barrier === true ? "barrier" : "stream",
      barrierReason: str(re.barrierReason),
      loc: find(`"${from}"`, 0),
    });
  }

  // A spec expresses a cycle as an edge that points back into an earlier node.
  const cycles: Cycle[] = [];
  for (const c of findCycles(nodes.map((n) => n.id), edges)) {
    cycles.push({
      nodes: c,
      // A spec has nowhere to hide a guard: it must say so explicitly.
      hasDryCounter: raw.nodes?.some((n) => /dry/i.test(String((n as any).loop?.until ?? ""))) ?? false,
      hasRoundCap: raw.nodes?.some((n) => num((n as any).loop?.maxRounds) !== null) ?? false,
      hasBudgetGuard: meta.budget !== null,
      dedupesAgainstConfirmed: false,
      loc: find('"edges"'),
    });
  }

  const graph: Graph = {
    file,
    kind: "spec",
    source,
    meta,
    nodes,
    edges,
    cycles,
    phaseCalls: [],
    logCalls: [],
    observations: [],
  };

  // Barrier without a reason is a spec-only check that the type system should
  // have caught; report it as an observation so one rule handles both inputs.
  for (const e of edges) {
    if (e.kind === "barrier" && !e.barrierReason) {
      graph.observations.push({
        type: "barrier-candidate",
        reason: null,
        onlyReshapes: true,
        loc: e.loc,
      });
    }
  }

  (graph as any).parseWarnings = warnings;
  return graph;
}

/** Tarjan-lite: any strongly connected component of size > 1, or a self-loop. */
export function findCycles(ids: string[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        if (!adj.has(w)) continue; // dangling edge, already warned
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }

    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const selfLoop = (adj.get(v) ?? []).includes(v);
      if (comp.length > 1 || selfLoop) out.push(comp.reverse());
    }
  };

  for (const id of ids) if (!index.has(id)) strongConnect(id);
  return out;
}

/** Nodes with no inbound edge that are not the declared entry point. */
export function findUnreachable(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  if (nodes.length === 0) return [];
  const hasInbound = new Set(edges.map((e) => e.to));
  const hasOutbound = new Set(edges.map((e) => e.from));
  const roots = nodes.filter((n) => !hasInbound.has(n.id));
  // The first root is the entry point by convention; any other root is orphaned.
  return roots.slice(1).filter((n) => hasOutbound.has(n.id) || edges.length > 0);
}
