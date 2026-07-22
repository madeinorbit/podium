import { expect, it } from 'vitest'

// SP-3f93: the node test lane MUST execute under the Bun runtime — server
// suites reach bun:sqlite through drizzle-orm/bun-sqlite's STATIC import, which
// real Node's ESM loader rejects at transform time ("Received protocol 'bun:'"),
// killing ~100 suites before any test runs (POD-195, was POD-96/POD-115).
//
// `bun run --bun vitest` silently ignores --bun for the vitest bin on bun
// 1.3.14 (main process and forked workers come up on real Node), so the test
// scripts invoke `bun --bun node_modules/vitest/vitest.mjs` directly. This
// guard makes any regression of that invocation one loud, self-explaining
// failure instead of a hundred cryptic ones.
it('node test lane runs under the Bun runtime', () => {
  expect(
    process.versions.bun,
    'vitest is running under real Node — the node lane needs the Bun runtime ' +
      '(bun:sqlite). Invoke it as `bun --bun node_modules/vitest/vitest.mjs …` ' +
      '(see package.json test:unit); plain `vitest` or `bun --bun vitest` ' +
      'both end up on Node.',
  ).toBeDefined()
})
