/** Orchestration: read a file, pick a front-end, run the rules, sort findings. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { parseScript } from "./parse/script.js";
import { parseSpec } from "./parse/spec.js";
import { ALL_RULES } from "./rules/index.js";
import type { Config, Finding, Graph, LintResult, Severity } from "./types.js";

export { ALL_RULES };

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** A spec is JSON; anything else that looks like a workflow is a script. */
export function detectKind(file: string, source: string): "script" | "spec" {
  const ext = extname(file);
  if (ext === ".json") return "spec";
  if (ext === ".js" || ext === ".mjs" || ext === ".ts") return "script";
  return source.trimStart().startsWith("{") ? "spec" : "script";
}

export function buildGraph(file: string, source: string): Graph {
  return detectKind(file, source) === "spec"
    ? parseSpec(file, source)
    : parseScript(file, source);
}

export function lintSource(file: string, source: string, config: Config = {}): LintResult {
  let graph: Graph;
  try {
    graph = buildGraph(file, source);
  } catch (e) {
    const err = e as Error & { graphlintParseError?: boolean };
    if (!err.graphlintParseError) throw err;
    return {
      file,
      kind: detectKind(file, source),
      findings: [
        {
          rule: "parse-error",
          severity: "error",
          message: err.message.replace(`${file}: `, ""),
          loc: { file, line: 1, column: 0 },
        },
      ],
      parseWarnings: [],
    };
  }

  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    const configured = config.rules?.[rule.id];
    if (configured === "off") continue;
    const severity: Severity = (configured as Severity) ?? rule.severity;

    rule.check({
      graph,
      report(f) {
        findings.push({ ...f, rule: rule.id, severity: f.severity ?? severity });
      },
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.loc.line - b.loc.line ||
      a.rule.localeCompare(b.rule),
  );

  return {
    file,
    kind: graph.kind,
    findings,
    parseWarnings: (graph as unknown as { parseWarnings?: string[] }).parseWarnings ?? [],
  };
}

export function lintFile(file: string, config: Config = {}): LintResult {
  return lintSource(file, readFileSync(file, "utf8"), config);
}

const WORKFLOW_EXT = new Set([".js", ".mjs", ".ts", ".json"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

/**
 * Collect lintable files. A bare directory means "the workflow specs in here" —
 * we do not lint every .js file in a repo, only files that look like a workflow
 * (a `.claude/workflows` path, a `*.graph.json`/`*.spec.json`, or a script that
 * actually calls `agent(`).
 */
export function collect(target: string): string[] {
  const out: string[] = [];
  const st = statSync(target);
  if (st.isFile()) return [target];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (WORKFLOW_EXT.has(extname(entry.name))) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(target);

  return out.filter((f) => {
    if (/\.(graph|spec|workflow)\.json$/.test(f)) return true;
    if (f.includes(`${".claude"}/workflows/`) || f.includes("workflows/")) return true;
    if (extname(f) === ".json") return false;
    try {
      const src = readFileSync(f, "utf8");
      return /\bagent\s*\(/.test(src) && /\b(parallel|pipeline|phase|export const meta)\b/.test(src);
    } catch {
      return false;
    }
  });
}

export function loadConfig(cwd: string): Config {
  for (const name of [".graphlintrc.json", "graphlint.config.json"]) {
    try {
      return JSON.parse(readFileSync(join(cwd, name), "utf8")) as Config;
    } catch {
      /* not there, or unreadable — defaults are fine */
    }
  }
  return {};
}

export function summarise(results: LintResult[]) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === "error") errors++;
      else if (f.severity === "warning") warnings++;
      else infos++;
    }
  }
  return { errors, warnings, infos, files: results.length };
}

export function rel(file: string): string {
  const r = relative(process.cwd(), file);
  return r.startsWith("..") ? file : r;
}
