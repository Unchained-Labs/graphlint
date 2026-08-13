// The auth-audit graph, written the way the reference architecture argues for.
// This fixture must lint clean — test/rules.test.ts asserts zero findings.

export const meta = {
  name: 'auth-audit',
  description: 'One agent per route handler, hunting for missing authorization checks',
  phases: [
    { title: 'Scope', detail: 'enumerate route files and the expected auth mechanism' },
    { title: 'Scan', detail: 'one cheap agent per surviving route' },
    { title: 'Verify', detail: 'three diverse lenses per finding' },
    { title: 'Report', detail: 'rank and write the remediation order' },
  ],
  budget: { tokens: 2_000_000, usd: 12 },
}

const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    issue: { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'exact code span — no paraphrase' },
  },
  required: ['file', 'line', 'issue', 'severity', 'evidence'],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: { real: { type: 'boolean' }, why: { type: 'string' } },
  required: ['real', 'why'],
}

const ROUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { routes: { type: 'array', items: { type: 'string' } } },
  required: ['routes'],
}

// Scope deep: decomposition quality sets the ceiling for everything downstream.
phase('Scope')
const scope = await agent(
  'Enumerate every route file and name the auth middleware this codebase uses.',
  { phase: 'Scope', model: 'claude-opus-5', schema: ROUTES_SCHEMA },
)

// The prefilter is plain code and costs nothing. It routinely halves the fan-out.
const routes = scope.routes.filter((r) => !alreadyGuarded(r))
if (routes.length < scope.routes.length) {
  log(`prefilter dropped ${scope.routes.length - routes.length} routes that already reference the auth middleware`)
}

// Three distinct lenses. Different questions, so they can fail independently.
const LENSES = [
  { key: 'authz', question: 'Can this handler be reached by a caller who should not reach it?' },
  { key: 'input', question: 'Is any user-controlled value trusted without validation here?' },
  { key: 'session', question: 'Is session state read or mutated without a freshness check?' },
]

// pipeline, not parallel: each route flows scan -> verify independently, so a
// slow route never holds up a fast one.
phase('Scan')
const perRoute = await pipeline(
  routes,
  (route) =>
    agent(`Inspect ${route} for a missing authorization check.`, {
      label: `scan:${route}`,
      phase: 'Scan',
      model: 'claude-haiku-4-5',
      schema: FINDING,
    }),
  (finding) =>
    parallel(
      LENSES.map((lens) => () =>
        agent(`${lens.question} Judge only this finding: ${finding.issue}`, {
          label: `verify:${lens.key}`,
          phase: 'Verify',
          model: 'claude-sonnet-5',
          schema: VERDICT,
        }),
      ),
    ).then((votes) => {
      const real = votes.filter(Boolean).filter((v) => v.real).length
      // Asymmetric threshold: a high-severity claim needs unanimity, a nit
      // passes on one vote. Uniform verification is how this gets expensive
      // without getting more correct.
      const needed = finding.severity === 'high' ? LENSES.length : 1
      return real >= needed ? { ...finding, votes: real } : null
    }),
)

// Reduce in plain code: flatten, drop the nulls, keep what survived.
const confirmed = perRoute.flat().filter(Boolean)

phase('Report')
const report = await agent(
  `Rank these ${confirmed.length} confirmed findings and write the remediation order.`,
  { phase: 'Report', model: 'claude-opus-5' },
)

return { confirmed, report }
