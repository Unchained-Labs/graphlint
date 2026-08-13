/**
 * Front-end for imperative Workflow scripts — `agent()`, `parallel()`,
 * `pipeline()`, `phase()`, `log()`, `export const meta`.
 *
 * This is a recursive descent rather than a flat visitor because almost every
 * interesting property is *contextual*: whether an `agent()` sits inside a
 * cycle, how many loops enclose it, which `pipeline` stage it belongs to, and
 * whether its result is consumed without a schema. A visitor that sees call
 * sites in isolation cannot answer any of those.
 *
 * Where a fact cannot be resolved statically the parser records `null` rather
 * than guessing. A rule that fires on a guess is worse than a rule that stays
 * quiet, because the first one trains people to pass `--no-verify`.
 */
import { parse } from "acorn";
import type {
  Cycle,
  Graph,
  GraphEdge,
  GraphMeta,
  GraphNode,
  Loc,
  Observation,
  Tier,
} from "../types.js";

type Node = any; // acorn's ESTree nodes, untyped by design here

const NONDETERMINISTIC = new Set(["Date.now", "Math.random", "performance.now"]);

/** Verbs that mean "this agent is doing plumbing a `flatMap` would do for free". */
const REDUCE_VERBS = [
  "combine",
  "merge",
  "flatten",
  "concatenate",
  "collect the results",
  "collate",
  "dedupe",
  "deduplicate",
  "aggregate",
  "join the results",
  "gather the results",
];

/** Prompt words that mark a node as a verifier rather than a worker. */
const VERIFIER_WORDS = [
  "verify",
  "refute",
  "skeptic",
  "judge",
  "adjudicate",
  "is this real",
  "confirm whether",
  "confirm that",
  "critique",
  "review this finding",
];

const TIER_BY_MODEL: Record<string, Tier> = {
  haiku: "cheap",
  "claude-haiku-4-5": "cheap",
  sonnet: "standard",
  "claude-sonnet-5": "standard",
  "claude-sonnet-4-6": "standard",
  opus: "deep",
  "claude-opus-5": "deep",
  "claude-opus-4-8": "deep",
  fable: "deep",
  "claude-fable-5": "deep",
};

interface Ctx {
  loopDepth: number;
  inCycle: boolean;
  /** Cycle currently being collected, if any. */
  cycle: Cycle | null;
  phase: string | null;
  /** Set when walking a `pipeline()` stage; used to chain stream edges. */
  pipelineStage: { id: string; index: number } | null;
}

export function parseScript(file: string, source: string): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cycles: Cycle[] = [];
  const phaseCalls: { title: string; loc: Loc }[] = [];
  const logCalls: Loc[] = [];
  const observations: Observation[] = [];
  const parseWarnings: string[] = [];

  let ast: Node;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    const err = e as Error & { loc?: { line: number; column: number } };
    throw Object.assign(new Error(`${file}: ${err.message}`), {
      graphlintParseError: true,
      loc: err.loc,
    });
  }

  const lines = source.split("\n");
  const loc = (n: Node): Loc => ({
    file,
    line: n.loc?.start.line ?? 1,
    column: n.loc?.start.column ?? 0,
    endLine: n.loc?.end.line,
    endColumn: n.loc?.end.column,
    text: (lines[(n.loc?.start.line ?? 1) - 1] ?? "").trim(),
  });

  let meta: GraphMeta = {
    present: false,
    name: null,
    description: null,
    phases: [],
    budget: null,
    loc: null,
  };

  let agentSeq = 0;

  // --- small static evaluators -----------------------------------------------

  const calleeName = (n: Node): string => {
    if (!n) return "";
    if (n.type === "Identifier") return n.name;
    if (n.type === "MemberExpression") {
      const obj = calleeName(n.object);
      const prop = n.computed ? "[]" : (n.property?.name ?? "");
      return obj ? `${obj}.${prop}` : prop;
    }
    return "";
  };

  /** Resolve a string-ish expression to text when possible. */
  const staticText = (n: Node): { text: string | null; isTemplate: boolean } => {
    if (!n) return { text: null, isTemplate: false };
    if (n.type === "Literal" && typeof n.value === "string") {
      return { text: n.value, isTemplate: false };
    }
    if (n.type === "TemplateLiteral") {
      const text = n.quasis.map((q: Node) => q.value.cooked ?? "").join(" … ");
      return { text, isTemplate: n.expressions.length > 0 };
    }
    if (n.type === "BinaryExpression" && n.operator === "+") {
      const l = staticText(n.left);
      const r = staticText(n.right);
      if (l.text !== null && r.text !== null) {
        return { text: l.text + r.text, isTemplate: l.isTemplate || r.isTemplate };
      }
    }
    return { text: null, isTemplate: false };
  };

  const objectProps = (n: Node): Map<string, Node> => {
    const m = new Map<string, Node>();
    if (!n || n.type !== "ObjectExpression") return m;
    for (const p of n.properties) {
      if (p.type !== "Property" || p.computed) continue;
      const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
      if (typeof key === "string") m.set(key, p.value);
    }
    return m;
  };

  const litNumber = (n: Node): number | null =>
    n && n.type === "Literal" && typeof n.value === "number" ? n.value : null;

  /** Source text of a subtree, for evidence in findings. */
  const src = (n: Node): string =>
    source.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 160);

  // --- meta -------------------------------------------------------------------

  const readMeta = (init: Node, node: Node) => {
    const p = objectProps(init);
    const phases: string[] = [];
    const ph = p.get("phases");
    if (ph?.type === "ArrayExpression") {
      for (const el of ph.elements) {
        const t = objectProps(el).get("title");
        const s = staticText(t);
        if (s.text) phases.push(s.text);
      }
    }
    const budgetNode = p.get("budget");
    let budget: GraphMeta["budget"] = null;
    if (budgetNode) {
      const b = objectProps(budgetNode);
      budget = { tokens: litNumber(b.get("tokens")), usd: litNumber(b.get("usd")) };
    }
    meta = {
      present: true,
      name: staticText(p.get("name")).text,
      description: staticText(p.get("description")).text,
      phases,
      budget,
      loc: loc(node),
    };
  };

  // --- agent() ----------------------------------------------------------------

  const readAgent = (n: Node, ctx: Ctx): GraphNode => {
    const opts = objectProps(n.arguments[1]);
    const promptArg = n.arguments[0];
    const { text: prompt, isTemplate } = staticText(promptArg);

    const modelLit = staticText(opts.get("model")).text;
    const label = staticText(opts.get("label")).text;
    const phase = staticText(opts.get("phase")).text ?? ctx.phase;
    const effort = staticText(opts.get("effort")).text;
    const isolation = staticText(opts.get("isolation")).text;
    const agentType = staticText(opts.get("agentType")).text;

    let tier: Tier = "unset";
    if (modelLit) {
      for (const [k, v] of Object.entries(TIER_BY_MODEL)) {
        if (modelLit.includes(k)) {
          tier = v;
          break;
        }
      }
      if (tier === "unset") tier = "standard";
    }

    const lower = (prompt ?? "").toLowerCase();
    const isVerifier = VERIFIER_WORDS.some((w) => lower.includes(w));

    const id = label ?? `agent#${++agentSeq}`;
    const node: GraphNode = {
      id,
      prompt,
      promptIsTemplate: isTemplate,
      phase,
      label,
      hasSchema: opts.has("schema"),
      tier,
      modelLiteral: modelLit,
      effort,
      isolation,
      agentType,
      fanout: null,
      loopDepth: ctx.loopDepth,
      inCycle: ctx.inCycle,
      isVerifier,
      loc: loc(n),
    };

    // A prompt whose verb is plumbing rather than judgment.
    if (prompt) {
      const verb = REDUCE_VERBS.find((v) => lower.includes(v));
      if (verb) observations.push({ type: "reduce-agent", verb, loc: loc(n) });
    }

    if (ctx.cycle) ctx.cycle.nodes.push(id);
    nodes.push(node);
    return node;
  };

  // --- cycle guard detection --------------------------------------------------

  /**
   * A cycle needs a dry-round counter AND a hard cap, and must dedupe against
   * everything *seen* rather than everything *confirmed*. Detected by reading
   * the loop's own source rather than by pattern-matching a fixed shape, because
   * there are many spellings of "dry rounds" and only one meaning.
   */
  const inspectCycle = (loopNode: Node): Omit<Cycle, "nodes"> => {
    const body = source.slice(loopNode.start, loopNode.end);
    const test = loopNode.test ? source.slice(loopNode.test.start, loopNode.test.end) : "";
    const all = body.toLowerCase();

    const hasDryCounter =
      /\bdry\b/.test(all) ||
      /consecutive/.test(all) ||
      /\bstale\b/.test(all) ||
      /nothing\s*new/.test(all) ||
      /unchanged/.test(all);

    // A hard cap is a bounded counter in the loop test, or an explicit round cap.
    const hasRoundCap =
      /\b(round|iter|attempt|pass|i)\w*\s*(<|<=)\s*\d+/.test(test.toLowerCase()) ||
      /\bmax(rounds|iterations|passes|attempts)\b/i.test(body) ||
      /\bround\w*\+\+[\s\S]{0,120}?(>=|>)\s*\d+/i.test(body);

    const hasBudgetGuard = /budget\s*\.\s*(remaining|total|spent)/i.test(body);

    // The termination bug from the reference: dedupe against `confirmed` (which
    // only grows when a finding survives) instead of `seen` (which grows every
    // round). Rejected findings then resurface forever.
    const dedupesAgainstConfirmed =
      /(confirmed|accepted|kept|survivors?)\s*\.\s*(has|includes|some|find)\b/i.test(body) &&
      !/\bseen\s*\.\s*(has|add)\b/i.test(body);

    return {
      hasDryCounter,
      hasRoundCap,
      hasBudgetGuard,
      dedupesAgainstConfirmed,
      loc: loc(loopNode),
    };
  };

  // --- the walk ---------------------------------------------------------------

  const SKIP = new Set(["Literal", "Identifier", "TemplateElement"]);

  const walk = (n: Node, ctx: Ctx): void => {
    if (!n || typeof n !== "object" || SKIP.has(n.type)) return;

    // export const meta = {...}
    if (
      n.type === "VariableDeclarator" &&
      n.id?.type === "Identifier" &&
      n.id.name === "meta" &&
      n.init?.type === "ObjectExpression"
    ) {
      readMeta(n.init, n);
    }

    if (n.type === "CallExpression") {
      const name = calleeName(n.callee);

      if (name === "agent") {
        readAgent(n, ctx);
        // still walk arguments (a nested agent() in a .then is real)
      } else if (name === "phase") {
        const t = staticText(n.arguments[0]).text;
        if (t) {
          phaseCalls.push({ title: t, loc: loc(n) });
          ctx = { ...ctx, phase: t };
        }
      } else if (name === "log") {
        logCalls.push(loc(n));
      } else if (name === "parallel") {
        handleParallel(n, ctx);
        return; // handler already walked the arguments — do not walk them twice
      } else if (name === "pipeline") {
        handlePipeline(n, ctx);
        return; // ditto
      } else if (NONDETERMINISTIC.has(name)) {
        observations.push({ type: "nondeterminism", callee: `${name}()`, loc: loc(n) });
      } else if (name.endsWith(".slice")) {
        const lim = n.arguments.length === 2 ? litNumber(n.arguments[1]) : litNumber(n.arguments[0]);
        observations.push({ type: "truncation", expr: src(n), limit: lim, loc: loc(n) });
      }
    }

    if (n.type === "NewExpression" && calleeName(n.callee) === "Date" && n.arguments.length === 0) {
      observations.push({ type: "nondeterminism", callee: "new Date()", loc: loc(n) });
    }

    // cycles
    if (n.type === "WhileStatement" || n.type === "DoWhileStatement" || n.type === "ForStatement") {
      const isCycle = n.type !== "ForStatement"; // a counted `for` is a fan-out, not a cycle
      const inner: Ctx = {
        ...ctx,
        loopDepth: ctx.loopDepth + 1,
        inCycle: ctx.inCycle || isCycle,
        cycle: ctx.cycle,
      };
      if (isCycle && !ctx.cycle) {
        const c: Cycle = { nodes: [], ...inspectCycle(n) };
        cycles.push(c);
        inner.cycle = c;
      }
      for (const k of childKeys(n)) walk((n as any)[k], inner);
      return;
    }

    for (const k of childKeys(n)) {
      const v = (n as any)[k];
      if (Array.isArray(v)) {
        for (const c of v) walk(c, ctx);
      } else {
        walk(v, ctx);
      }
    }
  };

  // --- parallel(): a barrier. Is it justified? --------------------------------

  function handleParallel(n: Node, ctx: Ctx) {
    const arg = n.arguments[0];
    const before = nodes.length;
    walkArg(arg, ctx);
    const spawned = nodes.slice(before);

    // Fan-out width when the thunk list is a literal array or a mapped literal.
    if (arg?.type === "ArrayExpression") {
      const w = arg.elements.length;
      for (const s of spawned) s.fanout ??= w;
    }
    detectReplication(arg, spawned);

    // Does the awaited result get anything more than a reshape? A barrier whose
    // consumer only flattens/maps/filters had no cross-set dependency, and the
    // same work streams with `pipeline()` for free.
    const consumer = findConsumer(n, boundName(n));
    const onlyReshapes = consumer.onlyReshapes;
    observations.push({
      type: "barrier-candidate",
      reason: consumer.crossSetHint,
      onlyReshapes,
      loc: loc(n),
    });
    observations.push({
      type: "fanin",
      guarded: consumer.guarded,
      expr: consumer.expr,
      loc: loc(n),
    });

    for (let i = 1; i < spawned.length; i++) {
      // siblings under a barrier: no edge between them, but record the join
    }
    if (spawned.length && consumer.node) {
      edges.push({
        from: spawned[0]!.id,
        to: "fan-in",
        channel: null,
        kind: "barrier",
        barrierReason: consumer.crossSetHint,
        loc: loc(n),
      });
    }
  }

  // --- pipeline(): streaming stages -------------------------------------------

  function handlePipeline(n: Node, ctx: Ctx) {
    const [items, ...stages] = n.arguments;
    walkArg(items, ctx);
    let prevStageFirst: GraphNode | null = null;
    stages.forEach((stage: Node, i: number) => {
      const before = nodes.length;
      walkArg(stage, { ...ctx, pipelineStage: { id: `stage${i}`, index: i } });
      const spawned = nodes.slice(before);
      if (items?.type === "ArrayExpression") {
        for (const s of spawned) s.fanout ??= items.elements.length;
      }
      detectReplication(stage, spawned);
      if (prevStageFirst && spawned[0]) {
        edges.push({
          from: prevStageFirst.id,
          to: spawned[0].id,
          channel: null,
          kind: "stream",
          barrierReason: null,
          loc: loc(stage),
        });
      }
      if (spawned[0]) prevStageFirst = spawned[0];
    });
  }

  function walkArg(a: Node, ctx: Ctx) {
    if (!a) return;
    walk(a, ctx);
  }

  /**
   * `Array.from({length: 3}, () => agent(SAME))` and
   * `[1,2,3].map(() => agent(SAME))` both mean "one verifier counted N times"
   * when the prompt does not vary with the index. Record the multiplicity on the
   * node so the identical-verifiers rule can see it without re-walking.
   */
  function detectReplication(arg: Node, spawned: GraphNode[]) {
    if (!arg || spawned.length !== 1) return;
    const s = spawned[0]!;
    const text = source.slice(arg.start, arg.end);
    const m = /Array\.from\(\s*\{\s*length\s*:\s*(\d+)/.exec(text);
    if (m) {
      s.fanout = Number(m[1]);
      // Does the factory use its index/parameter at all?
      const usesIndex = /\(\s*(?:_\s*,\s*)?([A-Za-z_$][\w$]*)\s*\)\s*=>/.exec(text);
      const param = usesIndex?.[1];
      const varies = param ? new RegExp(`\\$\\{[^}]*\\b${param}\\b`).test(text) : false;
      (s as any).__replicated = { count: Number(m[1]), varies };
    }
  }

  /**
   * Look upward from a `parallel()`/`pipeline()` call to see what its result is
   * used for. Cheap and deliberately shallow — we only need to distinguish
   * "reshaped" from "compared against the whole set".
   */
  /** If `await parallel(...)` is assigned, return the variable it binds to. */
  function boundName(n: Node): string | null {
    // Walk a tiny window backwards: `const x = await parallel(`
    const before = source.slice(Math.max(0, n.start - 80), n.start);
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
    return m ? m[1]! : null;
  }

  function findConsumer(n: Node, bound: string | null): {
    node: Node | null;
    onlyReshapes: boolean;
    guarded: boolean;
    expr: string;
    crossSetHint: string | null;
  } {
    // The enclosing statement's source is a good enough window.
    const stmtStart = Math.max(0, n.start - 200);
    const window = source.slice(stmtStart, Math.min(source.length, n.end + 300));
    const after = source.slice(n.end, Math.min(source.length, n.end + 300));

    // Everything the bound variable is later used for, if it is bound at all.
    const usage = bound
      ? [...source.matchAll(new RegExp(`\\b${bound}\\s*\\.\\s*(\\w+)`, "g"))].map((m) => m[1]!)
      : [];

    const guarded =
      /\.filter\s*\(\s*Boolean\s*\)/.test(after) ||
      /filter\(\s*Boolean\s*\)/.test(window) ||
      (bound !== null && new RegExp(`\\b${bound}\\s*\\.filter\\s*\\(\\s*Boolean`).test(source));

    // The only text that can justify a barrier is the text that *consumes* it:
    // the chained call, or the statements that read the bound variable.
    //
    // Scoped deliberately tight. An earlier version scanned a 300-character
    // window around the call, which matched the word "dedupe" in an unrelated
    // statement further down the file and silently suppressed the finding.
    const consumerText = [
      after.trimStart().split(/\n/).slice(0, 2).join(" "),
      ...(bound
        ? [...source.matchAll(new RegExp(`^.*\\b${bound}\\b.*$`, "gm"))]
            .map((m) => m[0])
            .filter((l) => !l.includes("parallel(") && !l.includes("pipeline("))
        : []),
    ].join(" ; ");

    const RESHAPE = new Set(["flat", "flatMap", "map", "filter", "forEach"]);
    const chainedReshape =
      /^\s*[\)\;]*\s*\.?(flat|flatMap|map|filter|forEach)\s*\(/.test(after.trimStart()) ||
      /^\s*\)?\s*\.(flat|flatMap|map)\(\)/.test(after.trimStart());
    // A bound result used only for reshaping never needed the whole set either.
    const boundReshapeOnly = usage.length > 0 && usage.every((u) => RESHAPE.has(u));

    // ...but being handed *into* a function is not a reshape. `f(all)` or
    // `f(all.filter(Boolean))` gives that function the entire set, which is
    // exactly the cross-set dependency a barrier exists for. Only method-chained
    // reshapes on the bound variable count as "reshape only".
    const passedIntoCall =
      bound !== null &&
      new RegExp(`[A-Za-z_$][\\w$]*\\s*\\(\\s*(?:\\.\\.\\.)?\\s*\\b${bound}\\b`).test(consumerText);

    const reshapeOnly = (chainedReshape || boundReshapeOnly) && !passedIntoCall;

    // Signals that the consumer genuinely needs the whole set at once.
    // No trailing \b: a helper called `dedupeByFileAndLine` is still a dedupe.
    const CROSS_SET = /\b(dedupe|dedup|uniq|unique|rank|sort|reduce|compare|cross|aggregate|total)/i;
    const crossSet = CROSS_SET.exec(consumerText);

    return {
      node: n,
      onlyReshapes: reshapeOnly && !crossSet,
      guarded,
      expr: after.trim().split("\n")[0]?.slice(0, 80) ?? "",
      crossSetHint: crossSet ? crossSet[0] : null,
    };
  }

  walk(ast, {
    loopDepth: 0,
    inCycle: false,
    cycle: null,
    phase: null,
    pipelineStage: null,
  });

  // write-capable agents without isolation
  for (const node of nodes) {
    const t = (node.prompt ?? "").toLowerCase();
    // "write a report" is prose, not a filesystem write. Require a write verb
    // with a filesystem-ish object, or an explicit git/commit action.
    const writes =
      /\b(edit|patch|modify|refactor|rewrite)\b[^.]{0,40}\b(file|module|source|code|test|config|repo)\b/.test(t) ||
      /\b(write|create|save)\b[^.]{0,30}\b(file|to disk|to the repo)\b/.test(t) ||
      /\b(commit|git add|git push|apply the (patch|fix|diff))\b/.test(t);
    if (writes) {
      observations.push({
        type: "write-capable",
        detail: node.label ?? node.id,
        isolated: node.isolation === "worktree",
        loc: node.loc,
      });
    }
  }

  return {
    file,
    kind: "script",
    source,
    meta,
    nodes,
    edges,
    cycles,
    phaseCalls,
    logCalls,
    observations,
  };
}

/** ESTree child keys, minus bookkeeping. */
function childKeys(n: Node): string[] {
  return Object.keys(n).filter(
    (k) => k !== "type" && k !== "start" && k !== "end" && k !== "loc" && k !== "range",
  );
}
