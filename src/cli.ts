#!/usr/bin/env node
/** graphlint CLI: check, rules, graph, explain. */
import { readFileSync } from "node:fs";

import { ALL_RULES, buildGraph, collect, lintFile, loadConfig, rel, summarise } from "./lint.js";
import { json, mermaid, pretty, sarif } from "./reporters/index.js";
import type { Config, LintResult, Severity } from "./types.js";

const VERSION = "0.1.0";

const HELP = `graphlint ${VERSION} — static analyzer for agent workflow specs

USAGE
  graphlint check [paths...]        lint workflow scripts and graph specs
  graphlint rules                  list every rule and what it enforces
  graphlint explain <rule>         the full reasoning for one rule
  graphlint graph <file>           print the parsed graph as a mermaid diagram

OPTIONS
  --format <fmt>    pretty (default) | json | sarif
  --verbose, -v     include the reasoning behind each finding
  --max-warnings N  exit non-zero if warnings exceed N (default: unlimited)
  --quiet, -q       suppress info-level findings
  --rule <id>       run only this rule (repeatable)
  --no-color        disable colour (or set NO_COLOR)
  --version         print version
  --help, -h        this

EXIT CODES
  0  no errors
  1  at least one error, or warnings above --max-warnings
  2  bad usage or an unreadable target

Defaults to the current directory when no path is given. A directory is scanned
for graph specs (*.graph.json, *.spec.json), anything under a workflows/
directory, and scripts that actually call agent() — not every .js file.
`;

interface Args {
  cmd: string;
  paths: string[];
  format: "pretty" | "json" | "sarif";
  verbose: boolean;
  quiet: boolean;
  maxWarnings: number;
  only: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: "check",
    paths: [],
    format: "pretty",
    verbose: false,
    quiet: false,
    maxWarnings: Infinity,
    only: [],
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--format":
        a.format = argv[++i] as Args["format"];
        break;
      case "--verbose":
      case "-v":
        a.verbose = true;
        break;
      case "--quiet":
      case "-q":
        a.quiet = true;
        break;
      case "--max-warnings":
        a.maxWarnings = Number(argv[++i]);
        break;
      case "--rule":
        a.only.push(argv[++i]!);
        break;
      case "--no-color":
        process.env.NO_COLOR = "1";
        break;
      default:
        rest.push(arg);
    }
  }

  if (rest.length && ["check", "rules", "explain", "graph"].includes(rest[0]!)) {
    a.cmd = rest.shift()!;
  }
  a.paths = rest;
  return a;
}

function cmdRules(): void {
  const w = Math.max(...ALL_RULES.map((r) => r.id.length));
  const bySeverity: Record<Severity, typeof ALL_RULES> = { error: [], warning: [], info: [] };
  for (const r of ALL_RULES) bySeverity[r.severity].push(r);

  for (const sev of ["error", "warning", "info"] as Severity[]) {
    const rules = bySeverity[sev];
    if (!rules.length) continue;
    console.log(`\n${sev.toUpperCase()}`);
    for (const r of rules) {
      console.log(`  ${r.id.padEnd(w)}  ${r.summary}`);
      console.log(`  ${" ".repeat(w)}  ${r.reference}`);
    }
  }
  console.log(`\n${ALL_RULES.length} rules. \`graphlint explain <rule>\` for the full reasoning.\n`);
}

function cmdExplain(id: string | undefined): number {
  if (!id) {
    console.error("usage: graphlint explain <rule>");
    return 2;
  }
  const rule = ALL_RULES.find((r) => r.id === id);
  if (!rule) {
    console.error(`unknown rule: ${id}`);
    console.error(`known rules: ${ALL_RULES.map((r) => r.id).join(", ")}`);
    return 2;
  }
  console.log(`\n${rule.id}  [${rule.severity}]`);
  console.log(`${"─".repeat(rule.id.length + rule.severity.length + 4)}`);
  console.log(`\n${rule.summary}`);
  console.log(`\nEnforces: ${rule.reference}`);
  console.log(
    `\nFull reasoning and the fix appear on each finding — run \`graphlint check --verbose\`.`,
  );
  console.log(`Docs: https://unchained-labs.github.io/graphlint/#${rule.id}\n`);
  return 0;
}

function cmdGraph(paths: string[]): number {
  if (!paths.length) {
    console.error("usage: graphlint graph <file>");
    return 2;
  }
  const graphs = paths.flatMap((p) =>
    collect(p).map((f) => buildGraph(f, readFileSync(f, "utf8"))),
  );
  if (!graphs.length) {
    console.error("no workflow specs found");
    return 2;
  }
  process.stdout.write(mermaid([], graphs));
  return 0;
}

function cmdCheck(a: Args): number {
  const targets = a.paths.length ? a.paths : ["."];
  let files: string[] = [];
  for (const t of targets) {
    try {
      files.push(...collect(t));
    } catch (e) {
      console.error(`graphlint: cannot read ${t}: ${(e as Error).message}`);
      return 2;
    }
  }
  files = [...new Set(files)];

  if (!files.length) {
    console.error(
      "graphlint: no workflow specs found. Looked for *.graph.json, *.spec.json,\n" +
        "           anything under workflows/, and scripts calling agent().",
    );
    return 0;
  }

  const config: Config = loadConfig(process.cwd());
  if (a.only.length) {
    config.rules = Object.fromEntries(
      ALL_RULES.map((r) => [r.id, a.only.includes(r.id) ? (config.rules?.[r.id] ?? r.severity) : "off"]),
    );
  }

  let results: LintResult[] = files.map((f) => lintFile(f, config));
  if (a.quiet) {
    results = results.map((r) => ({ ...r, findings: r.findings.filter((f) => f.severity !== "info") }));
  }

  switch (a.format) {
    case "json":
      process.stdout.write(json(results));
      break;
    case "sarif":
      process.stdout.write(sarif(results, VERSION));
      break;
    default:
      process.stdout.write(pretty(results, { verbose: a.verbose }));
  }

  const s = summarise(results);
  if (s.errors > 0) return 1;
  if (s.warnings > a.maxWarnings) {
    if (a.format === "pretty") {
      console.error(`graphlint: ${s.warnings} warnings exceeds --max-warnings ${a.maxWarnings}`);
    }
    return 1;
  }
  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes("--version")) {
    console.log(VERSION);
    return 0;
  }

  const a = parseArgs(argv);
  if (!["pretty", "json", "sarif"].includes(a.format)) {
    console.error(`graphlint: unknown --format "${a.format}" (pretty | json | sarif)`);
    return 2;
  }

  switch (a.cmd) {
    case "rules":
      cmdRules();
      return 0;
    case "explain":
      return cmdExplain(a.paths[0]);
    case "graph":
      return cmdGraph(a.paths);
    default:
      return cmdCheck(a);
  }
}

process.exitCode = main();
