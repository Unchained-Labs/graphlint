/**
 * The intermediate representation every front-end compiles to.
 *
 * There are two kinds of input — an imperative Workflow script (`agent()`,
 * `parallel()`, `pipeline()`) and a declarative GraphSpec (nodes + edges as
 * data). Both become a `Graph`, and every rule reads only the `Graph`. That
 * split is the whole reason a rule set written for one input shape also works
 * for the other.
 */

export type Severity = "error" | "warning" | "info";

/** Where in the source a finding lives. 1-indexed line, 0-indexed column. */
export interface Loc {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  /** The exact source text, so a report can show evidence rather than paraphrase. */
  text?: string;
}

/** A model tier. Mirrors the cost model: cheap/standard/deep. */
export type Tier = "cheap" | "standard" | "deep" | "unset";

/**
 * One unit of model work. In a script this is an `agent()` call site; in a spec
 * it is a `nodes[]` entry.
 */
export interface GraphNode {
  id: string;
  /** Static prompt text when it could be resolved, else null (template/variable). */
  prompt: string | null;
  /** Was the prompt built from a template literal with interpolation? */
  promptIsTemplate: boolean;
  phase: string | null;
  label: string | null;
  /** Explicit `schema:` on the call, or an output schema on a spec node. */
  hasSchema: boolean;
  /** Explicit `model:` / `tier:`. `unset` means "inherits the session model". */
  tier: Tier;
  modelLiteral: string | null;
  effort: string | null;
  isolation: string | null;
  agentType: string | null;
  /** Fan-out width if statically known (array length, `over` in a spec). */
  fanout: number | null;
  /** Depth of enclosing loops at the call site — a proxy for round multiplication. */
  loopDepth: number;
  /** True when this node sits inside a `while`/`do` cycle. */
  inCycle: boolean;
  /** Verifier-shaped: spawned per finding rather than per work unit. */
  isVerifier: boolean;
  loc: Loc;
}

export type EdgeKind = "stream" | "barrier";

export interface GraphEdge {
  from: string;
  to: string;
  /** Payload name. `findings`, not `step2`. Null when the front-end can't tell. */
  channel: string | null;
  kind: EdgeKind;
  /** Required when `kind === "barrier"`. */
  barrierReason: string | null;
  loc: Loc;
}

/** A `while`/`do-while` cycle and the termination guards found inside it. */
export interface Cycle {
  /** Node ids executed inside the cycle. */
  nodes: string[];
  hasDryCounter: boolean;
  hasRoundCap: boolean;
  hasBudgetGuard: boolean;
  /** Dedupes against the *confirmed* set rather than everything *seen*. */
  dedupesAgainstConfirmed: boolean;
  loc: Loc;
}

export interface GraphMeta {
  present: boolean;
  name: string | null;
  description: string | null;
  /** Phase titles declared in `meta.phases`. */
  phases: string[];
  budget: { tokens: number | null; usd: number | null } | null;
  loc: Loc | null;
}

export type SourceKind = "script" | "spec";

export interface Graph {
  file: string;
  kind: SourceKind;
  source: string;
  meta: GraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: Cycle[];
  /** `phase()` calls in a script, in source order. */
  phaseCalls: { title: string; loc: Loc }[];
  /** Every `log()` call site — used to tell a documented cap from a silent one. */
  logCalls: Loc[];
  /**
   * Raw observations a rule needs but that are not graph structure: barrier
   * candidates, nondeterministic calls, truncations, unguarded fan-ins.
   */
  observations: Observation[];
}

/** Front-end-collected facts that are cheaper to gather during the walk. */
export type Observation =
  | { type: "nondeterminism"; callee: string; loc: Loc }
  | { type: "truncation"; expr: string; limit: number | null; loc: Loc }
  | { type: "fanin"; guarded: boolean; expr: string; loc: Loc }
  | { type: "barrier-candidate"; reason: string | null; onlyReshapes: boolean; loc: Loc }
  | { type: "reduce-agent"; verb: string; loc: Loc }
  | { type: "consumed-unschema'd"; nodeId: string; how: string; loc: Loc }
  | { type: "write-capable"; detail: string; isolated: boolean; loc: Loc };

// --- findings ---------------------------------------------------------------

export interface Finding {
  /** Stable kebab-case rule id. Used for `--rule`, baselines and SARIF. */
  rule: string;
  severity: Severity;
  /** One sentence, present tense, naming the defect. */
  message: string;
  /** Why this costs money or correctness. Shown in verbose output. */
  detail?: string;
  /** What to do instead. */
  fix?: string;
  loc: Loc;
  /** Extra locations that participate (e.g. the other identical verifier). */
  related?: { loc: Loc; message: string }[];
}

export interface RuleContext {
  graph: Graph;
  /** Emit a finding. */
  report(f: Omit<Finding, "rule" | "severity"> & { severity?: Severity }): void;
}

export interface Rule {
  id: string;
  /** Default severity if the config does not override it. */
  severity: Severity;
  /** One line, used by `graphlint rules`. */
  summary: string;
  /** Which section of the reference architecture this enforces. */
  reference: string;
  check(ctx: RuleContext): void;
}

export interface LintResult {
  file: string;
  kind: SourceKind;
  findings: Finding[];
  /** Non-fatal parse problems (a file we could read but not fully understand). */
  parseWarnings: string[];
}

export interface Config {
  /** rule id -> severity, or "off". */
  rules?: Record<string, Severity | "off">;
  /** Glob-ish substrings of paths to skip. */
  ignore?: string[];
}
