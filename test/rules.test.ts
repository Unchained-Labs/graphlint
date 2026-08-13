import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ALL_RULES, buildGraph, lintSource } from "../src/lint.js";
import { json, mermaid, sarif } from "../src/reporters/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const read = (p: string) => readFileSync(join(FIXTURES, p), "utf8");

/** Lint a fixture and return the set of rule ids that fired. */
function rulesFired(path: string): Set<string> {
  const src = read(path);
  return new Set(lintSource(path, src).findings.map((f) => f.rule));
}

/** Lint an inline snippet as a script. */
function lint(code: string) {
  return lintSource("inline.js", code).findings;
}

describe("clean fixtures produce no findings", () => {
  it("the auth-audit script lints clean", () => {
    const r = lintSource("good/auth-audit.js", read("good/auth-audit.js"));
    expect(r.findings, JSON.stringify(r.findings, null, 2)).toEqual([]);
  });

  it("the auth-audit spec lints clean", () => {
    const r = lintSource("good/auth-audit.graph.json", read("good/auth-audit.graph.json"));
    expect(r.findings, JSON.stringify(r.findings, null, 2)).toEqual([]);
  });
});

describe("the kitchen-sink fixture trips every rule it is written to trip", () => {
  const fired = rulesFired("bad/kitchen-sink.js");

  for (const id of [
    "agent-as-reduce",
    "conjunction-prompt",
    "correlated-verifiers",
    "missing-meta",
    "missing-schema",
    "nondeterminism",
    "null-unsafe-fanin",
    "resurfacing-cycle",
    "silent-cap",
    "unbounded-cycle",
    "unisolated-writer",
    "unjustified-barrier",
    "untiered-graph",
  ]) {
    it(`fires ${id}`, () => expect(fired).toContain(id));
  }
});

describe("the broken spec trips the structural rules", () => {
  const fired = rulesFired("bad/orphan.graph.json");
  for (const id of ["spec-structure", "correlated-verifiers", "unjustified-barrier"]) {
    it(`fires ${id}`, () => expect(fired).toContain(id));
  }
});

// --- per-rule behaviour, including the cases that must NOT fire -------------

describe("agent-as-reduce", () => {
  it("fires when an agent is asked to combine results", () => {
    const f = lint('await agent("Combine the results into one list")');
    expect(f.map((x) => x.rule)).toContain("agent-as-reduce");
  });

  it("does not fire on a synthesis agent that writes a report", () => {
    const f = lint('await agent("Write the remediation report", { schema: S, model: "claude-opus-5" })');
    expect(f.map((x) => x.rule)).not.toContain("agent-as-reduce");
  });
});

describe("correlated-verifiers", () => {
  it("fires on N identical replicated verifiers", () => {
    const f = lint(`
      await parallel(Array.from({ length: 3 }, () => () =>
        agent("Verify this finding is real", { schema: V, model: "claude-sonnet-5" })))
    `);
    expect(f.map((x) => x.rule)).toContain("correlated-verifiers");
  });

  it("does not fire when the replica varies by index", () => {
    const f = lint(`
      const LENSES = ["authz", "input", "session"]
      await parallel(LENSES.map((lens) => () =>
        agent(\`Judge via the \${lens} lens\`, { schema: V, model: "claude-sonnet-5" })))
    `);
    expect(f.map((x) => x.rule)).not.toContain("correlated-verifiers");
  });

  it("does not fire when two verifiers use different models", () => {
    const f = lint(`
      await agent("Verify this finding is real", { model: "claude-sonnet-5", schema: V })
      await agent("Verify this finding is real", { model: "claude-opus-5", schema: V })
    `);
    expect(f.map((x) => x.rule)).not.toContain("correlated-verifiers");
  });
});

describe("unjustified-barrier", () => {
  it("fires when the barrier result is only flattened", () => {
    const f = lint(`
      const found = await parallel(items.map((i) => () => agent(\`scan \${i}\`, { schema: S })))
      const flat = found.flat()
    `);
    expect(f.map((x) => x.rule)).toContain("unjustified-barrier");
  });

  it("does not fire when the consumer dedupes across the whole set", () => {
    const f = lint(`
      const all = await parallel(items.map((i) => () => agent(\`scan \${i}\`, { schema: S })))
      const deduped = dedupeByFileAndLine(all.filter(Boolean))
    `);
    expect(f.map((x) => x.rule)).not.toContain("unjustified-barrier");
  });

  it("fires on a spec barrier with no barrierReason", () => {
    const f = lintSource(
      "s.graph.json",
      JSON.stringify({
        name: "x",
        nodes: [{ id: "a", tier: "cheap", outputSchema: "S" }, { id: "b", tier: "deep" }],
        edges: [{ from: "a", to: "b", channel: "findings", barrier: true }],
      }),
    ).findings;
    expect(f.map((x) => x.rule)).toContain("unjustified-barrier");
  });
});

describe("unbounded-cycle and resurfacing-cycle", () => {
  it("fires on a while loop with agents and no guards", () => {
    const f = lint('while (true) { await agent("find more bugs", { schema: S }) }');
    const ids = f.map((x) => x.rule);
    expect(ids).toContain("unbounded-cycle");
  });

  it("does not fire when a dry counter and a cap are present", () => {
    const f = lint(`
      let dry = 0
      let rounds = 0
      const seen = new Set()
      while (dry < 2 && rounds < 10) {
        rounds++
        const found = await agent("find more bugs", { schema: S, model: "claude-haiku-4-5" })
        const fresh = found.bugs.filter((b) => !seen.has(b.id))
        fresh.forEach((b) => seen.add(b.id))
        if (!fresh.length) dry++
        else dry = 0
      }
    `);
    expect(f.map((x) => x.rule)).not.toContain("unbounded-cycle");
  });

  it("flags deduping against confirmed rather than seen", () => {
    const f = lint(`
      const confirmed = []
      while (true) {
        const r = await agent("find bugs", { schema: S })
        const fresh = r.bugs.filter((b) => !confirmed.some((c) => c.id === b.id))
        confirmed.push(...fresh)
      }
    `);
    expect(f.map((x) => x.rule)).toContain("resurfacing-cycle");
  });

  it("does not flag a loop with no agent calls", () => {
    const f = lint("while (queue.length) { queue.pop() }");
    expect(f.map((x) => x.rule)).not.toContain("unbounded-cycle");
  });
});

describe("nondeterminism", () => {
  it.each([
    ["Date.now()", "const t = Date.now()"],
    ["Math.random()", "const r = Math.random()"],
    ["new Date()", "const d = new Date()"],
  ])("fires on %s", (_label, code) => {
    expect(lint(code).map((x) => x.rule)).toContain("nondeterminism");
  });

  it("does not fire on new Date(arg) — that is deterministic", () => {
    expect(lint('const d = new Date(args.stamp)').map((x) => x.rule)).not.toContain("nondeterminism");
  });
});

describe("silent-cap", () => {
  it("fires on a slice with no log", () => {
    expect(lint("const top = findings.slice(0, 10)").map((x) => x.rule)).toContain("silent-cap");
  });

  it("does not fire when the run logs something", () => {
    const f = lint(`
      const top = findings.slice(0, 10)
      log(\`dropped \${findings.length - 10} findings below the cut\`)
    `);
    expect(f.map((x) => x.rule)).not.toContain("silent-cap");
  });
});

describe("unisolated-writer", () => {
  it("does not fire on 'write a report' — that is prose, not a file", () => {
    const f = lint('await agent("Write a report ranking the findings", { schema: S })');
    expect(f.map((x) => x.rule)).not.toContain("unisolated-writer");
  });

  it("fires on an agent editing files in a fan-out", () => {
    const f = lint(
      'await parallel(files.map((f) => () => agent(`Edit the source file ${f}`, { schema: S })))',
    );
    expect(f.map((x) => x.rule)).toContain("unisolated-writer");
  });

  it("does not fire when the writer is isolated", () => {
    const f = lint(
      'await parallel(files.map((f) => () => agent(`Edit the source file ${f}`, { schema: S, isolation: "worktree" })))',
    );
    expect(f.map((x) => x.rule)).not.toContain("unisolated-writer");
  });
});

describe("phase-mismatch", () => {
  it("treats a phase assigned via opts.phase as used", () => {
    const f = lint(`
      export const meta = { name: "x", description: "y", phases: [{ title: "Verify" }] }
      await agent("check it", { phase: "Verify", schema: S, model: "claude-sonnet-5" })
    `);
    expect(f.map((x) => x.rule)).not.toContain("phase-mismatch");
  });

  it("fires on a phase() call not declared in meta", () => {
    const f = lint(`
      export const meta = { name: "x", description: "y", phases: [{ title: "Scan" }] }
      phase("Verify")
      await agent("check it", { schema: S, model: "claude-sonnet-5" })
    `);
    expect(f.map((x) => x.rule)).toContain("phase-mismatch");
  });
});

// --- parser -----------------------------------------------------------------

describe("parser", () => {
  it("does not double-register agents inside parallel()", () => {
    const g = buildGraph("inline.js", 'await parallel([() => agent("a"), () => agent("b")])');
    expect(g.nodes).toHaveLength(2);
  });

  it("does not double-register agents inside pipeline()", () => {
    const g = buildGraph(
      "inline.js",
      'await pipeline(items, (i) => agent(`one ${i}`), (r) => agent(`two ${r}`))',
    );
    expect(g.nodes).toHaveLength(2);
  });

  it("reads meta name, description and phases", () => {
    const g = buildGraph(
      "inline.js",
      'export const meta = { name: "n", description: "d", phases: [{ title: "A" }, { title: "B" }] }',
    );
    expect(g.meta.present).toBe(true);
    expect(g.meta.name).toBe("n");
    expect(g.meta.phases).toEqual(["A", "B"]);
  });

  it("maps model literals onto tiers", () => {
    const g = buildGraph(
      "inline.js",
      `
      await agent("a", { model: "claude-haiku-4-5" })
      await agent("b", { model: "claude-sonnet-5" })
      await agent("c", { model: "claude-opus-5" })
    `,
    );
    expect(g.nodes.map((n) => n.tier)).toEqual(["cheap", "standard", "deep"]);
  });

  it("marks nodes inside a while loop as in-cycle", () => {
    const g = buildGraph("inline.js", 'while (x) { await agent("a") }');
    expect(g.nodes[0]!.inCycle).toBe(true);
  });

  it("treats a counted for loop as fan-out, not a cycle", () => {
    const g = buildGraph("inline.js", 'for (let i = 0; i < 3; i++) { await agent("a") }');
    expect(g.cycles).toHaveLength(0);
  });

  it("reports a parse error as a finding rather than throwing", () => {
    const r = lintSource("broken.js", "const x = = =");
    expect(r.findings[0]!.rule).toBe("parse-error");
  });

  it("resolves a template literal prompt without crashing on interpolation", () => {
    const g = buildGraph("inline.js", "await agent(`scan ${file} now`)");
    expect(g.nodes[0]!.promptIsTemplate).toBe(true);
    expect(g.nodes[0]!.prompt).toContain("scan");
  });
});

// --- reporters --------------------------------------------------------------

describe("reporters", () => {
  const results = [lintSource("bad/kitchen-sink.js", read("bad/kitchen-sink.js"))];

  it("emits valid JSON with a summary", () => {
    const parsed = JSON.parse(json(results));
    expect(parsed.summary.errors).toBeGreaterThan(0);
    expect(parsed.results[0].findings.length).toBeGreaterThan(0);
  });

  it("emits SARIF 2.1.0 with a rule for every result", () => {
    const parsed = JSON.parse(sarif(results, "0.1.0"));
    expect(parsed.version).toBe("2.1.0");
    const declared = new Set(parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id));
    for (const res of parsed.runs[0].results) {
      expect(declared).toContain(res.ruleId);
    }
    for (const res of parsed.runs[0].results) {
      expect(res.locations[0].physicalLocation.region.startLine).toBeGreaterThan(0);
    }
  });

  it("emits a mermaid diagram for a spec", () => {
    const g = buildGraph("good/auth-audit.graph.json", read("good/auth-audit.graph.json"));
    const out = mermaid([], [g]);
    expect(out).toMatch(/^flowchart LR/);
    expect(out).toContain("scope");
    expect(out).toContain("==>"); // the justified barrier
  });
});

// --- rule metadata ----------------------------------------------------------

describe("rule metadata", () => {
  it("every rule has a unique kebab-case id", () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("every rule states a summary and a reference", () => {
    for (const r of ALL_RULES) {
      expect(r.summary.length, r.id).toBeGreaterThan(20);
      expect(r.reference.length, r.id).toBeGreaterThan(3);
    }
  });

  it("every finding carries a fix", () => {
    const all = [
      ...lintSource("bad/kitchen-sink.js", read("bad/kitchen-sink.js")).findings,
      ...lintSource("bad/orphan.graph.json", read("bad/orphan.graph.json")).findings,
    ];
    for (const f of all) {
      expect(f.fix, `${f.rule} has no fix`).toBeTruthy();
      expect(f.detail, `${f.rule} has no detail`).toBeTruthy();
    }
  });

  it("respects rules: off in config", () => {
    const src = read("bad/kitchen-sink.js");
    const off = lintSource("bad/kitchen-sink.js", src, { rules: { nondeterminism: "off" } });
    expect(off.findings.map((f) => f.rule)).not.toContain("nondeterminism");
  });

  it("respects a severity override in config", () => {
    const src = read("bad/kitchen-sink.js");
    const r = lintSource("bad/kitchen-sink.js", src, { rules: { "missing-schema": "error" } });
    const schemaFindings = r.findings.filter((f) => f.rule === "missing-schema");
    expect(schemaFindings.length).toBeGreaterThan(0);
    for (const f of schemaFindings) expect(f.severity).toBe("error");
  });
});
