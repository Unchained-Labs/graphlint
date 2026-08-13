/**
 * The rule set.
 *
 * Every rule enforces one line from the reference architecture, and every rule
 * carries the reason in `detail` — a linter that says "don't" without saying
 * "because" gets disabled by the second week.
 *
 * Severity convention:
 *   error   — costs money or does not terminate. Fails CI.
 *   warning — will cost money or correctness at scale.
 *   info    — a smell worth a look; never fails CI by default.
 */
import { findCycles, findUnreachable } from "../parse/spec.js";
import type { GraphNode, Rule } from "../types.js";

// --- helpers ----------------------------------------------------------------

/** Normalise a prompt for similarity comparison: collapse whitespace, drop
 *  interpolation markers, lowercase. Two prompts that differ only in the value
 *  they interpolate are the *same* prompt for correlation purposes. */
function normalise(p: string | null): string {
  if (!p) return "";
  return p
    .toLowerCase()
    .replace(/…/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/** Rough token-set similarity. Cheap and good enough to catch copy-paste. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = new Set(a.split(" ").filter((w) => w.length > 2));
  const sb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.max(sa.size, sb.size);
}

const LENS_HINTS = [
  "correctness",
  "security",
  "reproduce",
  "repro",
  "perf",
  "performance",
  "authz",
  "authn",
  "input validation",
  "session",
  "style",
  "readability",
  "concurrency",
];

/** Does this verifier state a distinct lens? */
function lensOf(node: GraphNode): string | null {
  const t = `${node.prompt ?? ""} ${node.label ?? ""}`.toLowerCase();
  return LENS_HINTS.find((l) => t.includes(l)) ?? null;
}

// --- rules ------------------------------------------------------------------

export const agentAsReduce: Rule = {
  id: "agent-as-reduce",
  severity: "error",
  summary: "An agent spawned to combine, merge or dedupe results — that is an edge, not a node.",
  reference: "§5 the edge contract",
  check({ graph, report }) {
    for (const o of graph.observations) {
      if (o.type !== "reduce-agent") continue;
      report({
        message: `This agent's job is "${o.verb}" — that is plumbing, not judgment.`,
        detail:
          "Reduce steps are free. Flattening and deduping is `flatMap` and a `Set`: deterministic, instant, zero tokens. Spawning an agent to do it pays rent on your own wiring, and adds a failure mode to a step that cannot otherwise fail.",
        fix: "Delete the agent and do it in plain code between the stages. Save agents for judgment.",
        loc: o.loc,
      });
    }
  },
};

export const unjustifiedBarrier: Rule = {
  id: "unjustified-barrier",
  severity: "warning",
  summary: "A barrier with no cross-set dependency — everything waits for the slowest node for nothing.",
  reference: "§7 the scheduler",
  check({ graph, report }) {
    for (const o of graph.observations) {
      if (o.type !== "barrier-candidate") continue;

      if (graph.kind === "spec" && o.reason === null) {
        report({
          message: "`barrier: true` with no `barrierReason`.",
          detail:
            "A barrier makes every item wait for the slowest one. That is sometimes correct and always expensive, so the spec requires the reason to be written down. \"The stages feel separate\" is not a reason — separate is not the same as synchronised.",
          fix: 'Add `barrierReason: "..."` naming the cross-set dependency, or set `barrier: false` and let it stream.',
          loc: o.loc,
        });
        continue;
      }

      if (o.onlyReshapes) {
        report({
          message: "This `parallel()` barrier's result is only reshaped, never compared across items.",
          detail:
            "`parallel()` awaits every thunk before returning. If the next thing you do is `.flat()`, `.map()` or `.filter()`, no step needed the whole set — you paid the slowest item's latency for a transform that works per item. Wall clock becomes sum-of-slowest-per-stage instead of slowest-single-chain.",
          fix: "Use `pipeline(items, stage1, stage2)` and put the reshape inside a stage. Keep the barrier only for a genuine cross-set need: dedupe before expensive downstream work, an early exit on the total, or a prompt that ranks items against each other.",
          loc: o.loc,
        });
      }
    }
  },
};

export const correlatedVerifiers: Rule = {
  id: "correlated-verifiers",
  severity: "error",
  summary: "N identical verifiers are one verifier counted N times, at N× the price.",
  reference: "§8 the verification layer",
  check({ graph, report }) {
    // Case 1: an explicitly replicated factory whose prompt does not vary.
    for (const n of graph.nodes) {
      const rep = (n as any).__replicated as { count: number; varies: boolean } | undefined;
      if (rep && rep.count > 1 && !rep.varies) {
        report({
          message: `${rep.count} verifiers spawned from one factory with no varying lens, model or index.`,
          detail:
            "Three skeptics with the same model, the same temperature and the same prompt scaffold are not three checks. They share priors and fail identically — you paid 3× to feel confident about a single error. Verification precision saturates after about two *independent* lenses; cost does not.",
          fix: "Vary the lens (three different questions beat three identical ones, and it is free), vary the model (cross-family verification breaks shared priors best), or replace the model verifier with an executable oracle — a test, a compiler, a linter.",
          loc: n.loc,
        });
      }
    }

    // Case 2: distinct verifier call sites whose prompts are near-identical.
    const verifiers = graph.nodes.filter((n) => n.isVerifier);
    for (let i = 0; i < verifiers.length; i++) {
      for (let j = i + 1; j < verifiers.length; j++) {
        const a = verifiers[i]!;
        const b = verifiers[j]!;
        const sim = similarity(normalise(a.prompt), normalise(b.prompt));
        if (sim < 0.85) continue;
        const differentModel = a.modelLiteral && b.modelLiteral && a.modelLiteral !== b.modelLiteral;
        const la = lensOf(a);
        const lb = lensOf(b);
        const differentLens = la && lb && la !== lb;
        if (differentModel || differentLens) continue;
        report({
          message: `These two verifiers ask the same question (${Math.round(sim * 100)}% prompt overlap) with the same model.`,
          detail:
            "They will agree with each other rather than with reality. Correlated verifiers inflate confidence without improving precision.",
          fix: "Give each verifier a distinct lens (correctness / security / does-it-reproduce), or route one to a different model family.",
          loc: b.loc,
          related: [{ loc: a.loc, message: "the other verifier" }],
        });
      }
    }

    // Case 3 (spec): a diverse-lens harness whose lenses are not actually diverse.
    for (const n of graph.nodes) {
      const lenses = ((n as any).__lenses ?? []) as string[];
      if (lenses.length > 1 && new Set(lenses).size < lenses.length) {
        report({
          message: `Node "${n.id}" declares duplicate verifier lenses: ${lenses.join(", ")}.`,
          detail: "Duplicated lenses cost full price and add no independence.",
          fix: "Make every lens a genuinely different question.",
          loc: n.loc,
        });
      }
    }
  },
};

export const missingSchema: Rule = {
  id: "missing-schema",
  severity: "warning",
  summary: "Free text consumed downstream — attach a schema so the contract is validated at the tool layer.",
  reference: "§4 the node contract",
  check({ graph, report }) {
    for (const n of graph.nodes) {
      if (n.hasSchema) continue;
      // A single terminal synthesis node returning prose is legitimate.
      const isTerminal = !graph.edges.some((e) => e.from === n.id);
      const onlyNode = graph.nodes.length === 1;
      if (onlyNode) continue;
      if (isTerminal && graph.nodes.length > 1 && !n.isVerifier) continue;

      report({
        message: `Agent "${n.id}" returns free text but its result feeds another step.`,
        detail:
          "Without a schema the result is a string, so a downstream step parses prose and a malformed answer surfaces three nodes later as a confusing failure. With one, validation happens at the tool-call layer and the model retries on mismatch — the cheapest error handling available.",
        fix: "Pass `schema:` with a JSON Schema. Set `additionalProperties: false` and require the fields you actually read.",
        loc: n.loc,
      });
    }
  },
};

export const untieredGraph: Rule = {
  id: "untiered-graph",
  severity: "warning",
  summary: "Every node inherits the session model — that is the default bill, not a decision.",
  reference: "§9 cost governor & model tiering",
  check({ graph, report }) {
    if (graph.nodes.length < 3) return;
    const tiered = graph.nodes.filter((n) => n.tier !== "unset" || n.effort);
    if (tiered.length > 0) return;
    const first = graph.nodes[0]!;
    report({
      message: `${graph.nodes.length} agents and no model or effort set on any of them.`,
      detail:
        "Every subagent inherits your session model unless you say otherwise. A mechanical, schema-constrained first-pass scan does not need your deepest model, and a fan-out is where that mistake multiplies: 40 units on a deep tier instead of a cheap one is the single largest avoidable line item in these graphs.",
      fix: "Tier the graph: cheap for mechanical extraction and first-pass scans, standard for scoped reasoning and verifier lenses, deep for the one or two nodes whose judgment reaches the user.",
      loc: first.loc,
    });
  },
};

export const unboundedCycle: Rule = {
  id: "unbounded-cycle",
  severity: "error",
  summary: "A cycle with no dry-round counter or no hard cap is a budget incinerator.",
  reference: "§8 convergence for discovery loops",
  check({ graph, report }) {
    for (const c of graph.cycles) {
      if (c.nodes.length === 0) continue; // a loop with no model calls is just code
      const missing: string[] = [];
      if (!c.hasDryCounter) missing.push("a dry-round counter");
      if (!c.hasRoundCap && !c.hasBudgetGuard) missing.push("a hard round or budget cap");
      if (missing.length === 0) continue;
      report({
        message: `This cycle spawns agents and is missing ${missing.join(" and ")}.`,
        detail:
          "Unknown-size jobs need a cycle, and a cycle that does not converge spends until something else stops it. The dry counter is the heuristic that ends the loop early; the hard cap is the guarantee that it ends at all. You need both — the counter can be defeated by a finder that always returns something marginal.",
        fix: "Stop after K consecutive rounds that surface nothing new, and keep a `maxRounds` (or a `budget.remaining()` check) as the backstop.",
        loc: c.loc,
      });
    }
  },
};

export const resurfacingCycle: Rule = {
  id: "resurfacing-cycle",
  severity: "error",
  summary: "A cycle deduping against confirmed findings instead of everything seen never terminates.",
  reference: "§8 convergence for discovery loops",
  check({ graph, report }) {
    for (const c of graph.cycles) {
      if (!c.dedupesAgainstConfirmed) continue;
      report({
        message: "This cycle dedupes against confirmed results rather than everything seen.",
        detail:
          "`confirmed` only grows when a finding survives verification. Anything the judge rejected is not in it, so the next round rediscovers the same dead ends, pays to verify them again, and rejects them again. The dry-round counter never trips because every round looks productive.",
        fix: "Keep a `seen` set keyed on every candidate you have *looked at*, rejected ones included, and dedupe against that. Track `confirmed` separately for the output.",
        loc: c.loc,
      });
    }
  },
};

export const conjunctionPrompt: Rule = {
  id: "conjunction-prompt",
  severity: "info",
  summary: 'A prompt containing "and" is usually two nodes.',
  reference: "§4 the node contract",
  check({ graph, report }) {
    for (const n of graph.nodes) {
      if (!n.prompt || n.prompt.length < 24) continue;
      // Two imperative verbs joined by "and" is the signal, not any "and".
      const m = /\b(find|scan|extract|read|analyse|analyze|review|search|check|list|fetch)\b[^.]{0,60}\band\b[^.]{0,20}\b(write|report|fix|summarise|summarize|rank|apply|create|generate|patch|edit|commit)\b/i.exec(
        n.prompt,
      );
      if (!m) continue;
      report({
        message: `Agent "${n.id}" is asked to ${m[1]} and ${m[2]} in one call.`,
        detail:
          "A node you cannot describe in one sentence is a node you cannot verify, tier or retry. These two halves want different models — the scan is mechanical, the write is judgment — and a retry on the write re-runs the scan for nothing.",
        fix: "Split into two nodes with a typed edge between them.",
        loc: n.loc,
      });
    }
  },
};

export const nullUnsafeFanin: Rule = {
  id: "null-unsafe-fanin",
  severity: "error",
  summary: "A fan-in that assumes a full result set dies when one node fails.",
  reference: "§11 failure isolation & blast radius",
  check({ graph, report }) {
    for (const o of graph.observations) {
      if (o.type !== "fanin" || o.guarded) continue;
      report({
        message: "This fan-in consumes agent results without filtering nulls.",
        detail:
          "A thunk that throws resolves to `null` instead of sinking the batch — that containment is the point. But the consumer then reads a property off `null` and the whole run dies at the join, which throws away every result the other agents produced. \"8 of 9 sources returned\" should degrade the answer, not kill the job.",
        fix: "`.filter(Boolean)` before you use the array, and make the synthesis prompt tolerate a short list.",
        loc: o.loc,
      });
    }
  },
};

export const nondeterminism: Rule = {
  id: "nondeterminism",
  severity: "error",
  summary: "Date.now(), Math.random() and argless new Date() invalidate the resume cache.",
  reference: "§7 determinism",
  check({ graph, report }) {
    for (const o of graph.observations) {
      if (o.type !== "nondeterminism") continue;
      report({
        message: `${o.callee} inside a journaled run.`,
        detail:
          "The journal is keyed on the hash of node id, input, prompt and model. A value that changes between runs changes that key, so a resumed run re-executes nodes that already succeeded and a replay cannot be served from cache. That turns a crashed 200-agent run from a series of cache hits into a full re-spend.",
        fix: "Pass timestamps in as arguments from outside the graph, and vary agents by index rather than by seed.",
        loc: o.loc,
      });
    }
  },
};

export const silentCap: Rule = {
  id: "silent-cap",
  severity: "warning",
  summary: "A truncated work list with no log reads as full coverage.",
  reference: "§13 anti-pattern checklist",
  check({ graph, report }) {
    for (const o of graph.observations) {
      if (o.type !== "truncation") continue;
      if (graph.logCalls.length > 0) continue; // something is reported; assume this is it
      report({
        message: `This slices the work list${o.limit !== null ? ` to ${o.limit} items` : ""} without logging what was dropped.`,
        detail:
          "Bounding coverage is a legitimate cost decision. Bounding it silently is not: the report that comes out the other end reads as \"we checked everything\" when it checked the first N. Whoever acts on that output cannot tell the difference.",
        fix: "`log()` the count you dropped and why, and say so in the final output.",
        loc: o.loc,
      });
    }
  },
};

export const phaseMismatch: Rule = {
  id: "phase-mismatch",
  severity: "info",
  summary: "phase() titles and meta.phases disagree, so the progress display fragments.",
  reference: "meta contract",
  check({ graph, report }) {
    if (!graph.meta.present || graph.meta.phases.length === 0) return;
    const declared = new Set(graph.meta.phases);
    // A phase counts as used whether it was opened with phase() or assigned
    // directly on a node via `opts.phase` — the latter is the form that survives
    // concurrent pipeline stages, so it must not be reported as unused.
    const used = new Set([
      ...graph.phaseCalls.map((p) => p.title),
      ...graph.nodes.map((n) => n.phase).filter((p): p is string => p !== null),
    ]);
    for (const call of graph.phaseCalls) {
      if (!declared.has(call.title)) {
        report({
          message: `phase("${call.title}") is not declared in meta.phases.`,
          detail:
            "Phase titles are matched exactly. An undeclared phase still renders, but as its own ungrouped box, so the progress tree stops matching the plan you published in `meta`.",
          fix: `Add { title: "${call.title}" } to meta.phases, or use one of: ${[...declared].join(", ")}.`,
          loc: call.loc,
        });
      }
    }
    for (const d of declared) {
      if (!used.has(d) && graph.phaseCalls.length > 0) {
        report({
          message: `meta.phases declares "${d}" but no phase() call uses it.`,
          detail: "The progress display will show a phase that never runs.",
          fix: `Remove it from meta.phases, or call phase("${d}").`,
          loc: graph.meta.loc ?? graph.nodes[0]?.loc ?? { file: graph.file, line: 1, column: 0 },
        });
      }
    }
  },
};

export const missingMeta: Rule = {
  id: "missing-meta",
  severity: "warning",
  summary: "No `export const meta` — the run has no name, description or phase plan.",
  reference: "meta contract",
  check({ graph, report }) {
    if (graph.kind !== "script") return;
    if (graph.meta.present) return;
    if (graph.nodes.length === 0) return;
    report({
      message: "This script spawns agents but exports no `meta`.",
      detail:
        "`meta` is what the permission dialog and the progress display read. Without it a run shows up unnamed, its phases ungrouped, and a reviewer approving it cannot see what it intends to do.",
      fix: "Add `export const meta = { name, description, phases: [...] }` at the top. It must be a pure literal — no variables or interpolation.",
      loc: { file: graph.file, line: 1, column: 0 },
    });
  },
};

export const unisolatedWriter: Rule = {
  id: "unisolated-writer",
  severity: "error",
  summary: "Parallel agents that write to the filesystem without worktree isolation collide.",
  reference: "§11 write collisions",
  check({ graph, report }) {
    for (const o of graph.observations) {
      if (o.type !== "write-capable" || o.isolated) continue;
      const node = graph.nodes.find((n) => n.loc.line === o.loc.line);
      const parallel = node && (node.fanout === null || node.fanout > 1);
      if (!parallel) continue;
      report({
        message: `Agent "${o.detail}" edits files and runs in a fan-out without \`isolation: "worktree"\`.`,
        detail:
          "Concurrent writers on one checkout interleave edits and produce a tree that compiles but is not what any of them intended. The failure is silent — no error, just a wrong result that survives review because each individual diff looks fine.",
        fix: 'Add `isolation: "worktree"` to the writing agents and merge at the fan-in. Keep read-only agents on the shared checkout — worktrees cost setup and disk, so isolate only real writers.',
        loc: o.loc,
      });
    }
  },
};

export const uniformVerification: Rule = {
  id: "uniform-verification",
  severity: "info",
  summary: "Verifying every finding equally hard spends the budget on things nobody will fix.",
  reference: "§8 asymmetric thresholds",
  check({ graph, report }) {
    const verifiers = graph.nodes.filter((n) => n.isVerifier);
    if (verifiers.length < 2) return;
    // No severity/threshold vocabulary anywhere near the verify stage.
    const text = graph.source.toLowerCase();
    const asymmetric =
      /severity|critical|high|low|unanim|threshold|passif|majority|oracle/.test(text);
    if (asymmetric) return;
    report({
      message: `${verifiers.length} verifier lenses applied uniformly, with no severity threshold.`,
      detail:
        "Verification is usually the biggest line item — findings × lenses, not fan-out width. Spending the same three lenses on a low-severity nit as on an auth bypass is how these systems get expensive without getting more correct.",
      fix: "Make the threshold asymmetric: cheap-to-fix findings pass on one vote; destructive or high-severity ones need unanimity plus an executable oracle.",
      loc: verifiers[0]!.loc,
    });
  },
};

export const specStructure: Rule = {
  id: "spec-structure",
  severity: "error",
  summary: "A spec with an unreachable node or an uncontrolled cycle would fail at run time.",
  reference: "§2 graph IR",
  check({ graph, report }) {
    if (graph.kind !== "spec") return;

    for (const n of findUnreachable(graph.nodes, graph.edges)) {
      report({
        message: `Node "${n.id}" has no inbound edge and is not the entry point.`,
        detail: "It will never execute. Cycle and reachability checks are the cheapest ones available — they run before a token is spent.",
        fix: "Wire an inbound edge, or delete the node.",
        loc: n.loc,
      });
    }

    const ids = graph.nodes.map((n) => n.id);
    for (const comp of findCycles(ids, graph.edges)) {
      const guarded = graph.cycles.some(
        (c) => c.hasRoundCap || c.hasBudgetGuard,
      );
      if (guarded) continue;
      report({
        message: `Cycle in the spec (${comp.join(" → ")} → ${comp[0]}) with no declared round cap or budget.`,
        detail:
          "A declarative cycle has nowhere to hide a guard — if the spec does not state the cap, nothing enforces one.",
        fix: "Add a `loop: { maxRounds: N, until: \"2 dry rounds\" }` to the looping node, or a top-level `budget`.",
        loc: graph.cycles[0]?.loc ?? graph.nodes[0]!.loc,
      });
    }
  },
};

export const ALL_RULES: Rule[] = [
  agentAsReduce,
  unjustifiedBarrier,
  correlatedVerifiers,
  missingSchema,
  untieredGraph,
  unboundedCycle,
  resurfacingCycle,
  conjunctionPrompt,
  nullUnsafeFanin,
  nondeterminism,
  silentCap,
  phaseMismatch,
  missingMeta,
  unisolatedWriter,
  uniformVerification,
  specStructure,
];
