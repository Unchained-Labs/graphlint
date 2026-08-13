// A workflow that makes most of the mistakes in the reference architecture.
// Used as a fixture: every rule that fires here is asserted in test/rules.test.ts.
// Do not "fix" this file.

const DIMENSIONS = ["bugs", "perf", "security"];

// no `export const meta` -> missing-meta

phase("Find")

const runId = Date.now()                      // nondeterminism
const seed = Math.random()                    // nondeterminism

// parallel() whose result is only flattened -> unjustified-barrier
// no .filter(Boolean) -> null-unsafe-fanin
const found = await parallel(
  DIMENSIONS.map((d) => () => agent(`Find every ${d} issue in the changed files`)),
)
const flat = found.flat()

// an agent doing plumbing -> agent-as-reduce
const merged = await agent(`Combine the results from the finders and dedupe them`)

// three identical verifiers -> correlated-verifiers
const votes = await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(`Verify this finding is real. Answer yes or no.`),
  ),
)

// a prompt doing two jobs -> conjunction-prompt
const both = await agent(
  `Scan every route handler for missing authorization and write a remediation report`,
)

// silent truncation with no log() -> silent-cap
const shortlist = flat.slice(0, 10)

// a cycle with no dry counter and no cap -> unbounded-cycle
// deduping against `confirmed` -> resurfacing-cycle
const confirmed = []
while (true) {
  const round = await agent(`Find bugs we have not found yet`)
  const fresh = round.bugs.filter((b) => !confirmed.some((c) => c.id === b.id))
  confirmed.push(...fresh)
}

// a writer in a fan-out with no isolation -> unisolated-writer
await parallel(
  DIMENSIONS.map((d) => () => agent(`Edit the ${d} module and commit the fix`)),
)

// no model/effort anywhere -> untiered-graph
// no schema anywhere -> missing-schema
