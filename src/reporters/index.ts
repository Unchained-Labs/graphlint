/** Output formats: a terminal report with code frames, JSON, and SARIF. */
import { readFileSync } from "node:fs";

import { rel, summarise } from "../lint.js";
import { ALL_RULES } from "../rules/index.js";
import type { Finding, LintResult, Severity } from "../types.js";

// --- colour -----------------------------------------------------------------

const useColour =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  Boolean(process.stdout.isTTY);

const c = (code: string) => (s: string) => (useColour ? `[${code}m${s}[0m` : s);
const dim = c("2");
const bold = c("1");
const red = c("31");
const yellow = c("33");
const cyan = c("36");
const grey = c("90");
const green = c("32");

const MARK: Record<Severity, string> = { error: "✗", warning: "!", info: "·" };
const PAINT: Record<Severity, (s: string) => string> = {
  error: red,
  warning: yellow,
  info: cyan,
};

// --- pretty -----------------------------------------------------------------

/** A two-line code frame: the offending line and a caret run beneath it. */
function frame(f: Finding, source: string | null): string[] {
  if (!source) return [];
  const lines = source.split("\n");
  const line = lines[f.loc.line - 1];
  if (line === undefined) return [];
  const gutter = String(f.loc.line);
  const pad = " ".repeat(gutter.length);
  const start = Math.max(0, f.loc.column);
  const end =
    f.loc.endLine === f.loc.line && f.loc.endColumn ? Math.max(f.loc.endColumn, start + 1) : start + 1;
  const width = Math.min(Math.max(end - start, 1), Math.max(line.length - start, 1));

  return [
    `   ${grey(`${gutter} │`)} ${line.replace(/\t/g, "  ")}`,
    `   ${grey(`${pad} │`)} ${" ".repeat(start)}${PAINT[f.severity]("~".repeat(width))}`,
  ];
}

export function pretty(results: LintResult[], opts: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  const sourceCache = new Map<string, string | null>();
  const readSource = (file: string): string | null => {
    if (!sourceCache.has(file)) {
      try {
        sourceCache.set(file, readFileSync(file, "utf8"));
      } catch {
        sourceCache.set(file, null);
      }
    }
    return sourceCache.get(file) ?? null;
  };

  for (const r of results) {
    if (r.findings.length === 0 && r.parseWarnings.length === 0) continue;
    out.push("");
    out.push(`${bold(rel(r.file))} ${grey(`(${r.kind})`)}`);

    for (const w of r.parseWarnings) out.push(`   ${yellow("!")} ${dim(w)}`);

    for (const f of r.findings) {
      const paint = PAINT[f.severity];
      out.push("");
      out.push(
        `  ${paint(MARK[f.severity])} ${f.message}  ${grey(f.rule)}`,
      );
      out.push(...frame(f, readSource(f.loc.file)));
      if (f.related?.length) {
        for (const rl of f.related) {
          out.push(`   ${grey(`→ ${rel(rl.loc.file)}:${rl.loc.line} — ${rl.message}`)}`);
        }
      }
      if (opts.verbose && f.detail) {
        out.push("");
        out.push(...wrap(f.detail, 74).map((l) => `     ${dim(l)}`));
      }
      if (f.fix) {
        out.push(`     ${green("fix")} ${f.fix.length > 200 && !opts.verbose ? f.fix.slice(0, 200) + "…" : f.fix}`);
      }
    }
  }

  const s = summarise(results);
  out.push("");
  if (s.errors + s.warnings + s.infos === 0) {
    out.push(`${green("✓")} ${s.files} file${s.files === 1 ? "" : "s"} clean`);
  } else {
    const parts: string[] = [];
    if (s.errors) parts.push(red(`${s.errors} error${s.errors === 1 ? "" : "s"}`));
    if (s.warnings) parts.push(yellow(`${s.warnings} warning${s.warnings === 1 ? "" : "s"}`));
    if (s.infos) parts.push(cyan(`${s.infos} info`));
    out.push(`${parts.join(grey(" · "))} ${grey(`in ${s.files} file${s.files === 1 ? "" : "s"}`)}`);
    if (!opts.verbose) out.push(grey("run with --verbose for the reasoning behind each finding"));
  }
  out.push("");
  return out.join("\n");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// --- json -------------------------------------------------------------------

export function json(results: LintResult[]): string {
  return `${JSON.stringify(
    {
      summary: summarise(results),
      results: results.map((r) => ({
        file: rel(r.file),
        kind: r.kind,
        parseWarnings: r.parseWarnings,
        findings: r.findings.map((f) => ({
          rule: f.rule,
          severity: f.severity,
          message: f.message,
          detail: f.detail,
          fix: f.fix,
          line: f.loc.line,
          column: f.loc.column,
          endLine: f.loc.endLine,
          endColumn: f.loc.endColumn,
          related: f.related?.map((rl) => ({
            file: rel(rl.loc.file),
            line: rl.loc.line,
            message: rl.message,
          })),
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

// --- sarif ------------------------------------------------------------------

const SARIF_LEVEL: Record<Severity, string> = {
  error: "error",
  warning: "warning",
  info: "note",
};

/**
 * SARIF 2.1.0, so findings land in the GitHub Security tab via
 * `github/codeql-action/upload-sarif`.
 */
export function sarif(results: LintResult[], version: string): string {
  const usedRules = new Set(results.flatMap((r) => r.findings.map((f) => f.rule)));

  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "graphlint",
              version,
              informationUri: "https://unchained-labs.github.io/graphlint/",
              rules: ALL_RULES.filter((r) => usedRules.has(r.id)).map((r) => ({
                id: r.id,
                name: r.id,
                shortDescription: { text: r.summary },
                fullDescription: { text: `${r.summary} (${r.reference})` },
                defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
                helpUri: `https://unchained-labs.github.io/graphlint/#${r.id}`,
                properties: { tags: ["agent-workflow", "cost", r.reference] },
              })),
            },
          },
          results: results.flatMap((r) =>
            r.findings
              .filter((f) => f.rule !== "parse-error")
              .map((f) => ({
                ruleId: f.rule,
                level: SARIF_LEVEL[f.severity],
                message: { text: f.fix ? `${f.message} Fix: ${f.fix}` : f.message },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: rel(f.loc.file) },
                      region: {
                        startLine: f.loc.line,
                        startColumn: f.loc.column + 1,
                        ...(f.loc.endLine ? { endLine: f.loc.endLine } : {}),
                      },
                    },
                  },
                ],
                relatedLocations: f.related?.map((rl, i) => ({
                  id: i,
                  physicalLocation: {
                    artifactLocation: { uri: rel(rl.loc.file) },
                    region: { startLine: rl.loc.line },
                  },
                  message: { text: rl.message },
                })),
              })),
          ),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

// --- mermaid (graph visualisation) ------------------------------------------

/** Renders the parsed IR as a mermaid diagram — `graphlint graph <file>`. */
export function mermaid(results: { file: string }[], graphs: import("../types.js").Graph[]): string {
  const out: string[] = ["flowchart LR"];
  for (const g of graphs) {
    const byPhase = new Map<string, typeof g.nodes>();
    for (const n of g.nodes) {
      const key = n.phase ?? "unphased";
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key)!.push(n);
    }
    const safe = (s: string) => s.replace(/[^\w]/g, "_");
    for (const [phase, ns] of byPhase) {
      out.push(`  subgraph ${safe(phase)}["${phase}"]`);
      for (const n of ns) {
        const tier = n.tier === "unset" ? "?" : n.tier;
        const fan = n.fanout && n.fanout > 1 ? ` ×${n.fanout}` : "";
        out.push(`    ${safe(n.id)}["${n.id}<br/><small>${tier}${fan}</small>"]`);
      }
      out.push("  end");
    }
    for (const e of g.edges) {
      const arrow = e.kind === "barrier" ? "==>" : "-->";
      const label = e.channel ? `|${e.channel}|` : "";
      out.push(`  ${safe(e.from)} ${arrow}${label} ${safe(e.to)}`);
    }
  }
  return `${out.join("\n")}\n`;
}
