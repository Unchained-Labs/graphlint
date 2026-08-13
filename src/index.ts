/** graphlint as a library. The CLI is a thin wrapper over these. */
export { ALL_RULES, buildGraph, collect, detectKind, lintFile, lintSource, loadConfig, summarise } from "./lint.js";
export { json, mermaid, pretty, sarif } from "./reporters/index.js";
export type {
  Config, Cycle, EdgeKind, Finding, Graph, GraphEdge, GraphMeta, GraphNode,
  LintResult, Loc, Observation, Rule, RuleContext, Severity, SourceKind, Tier,
} from "./types.js";
