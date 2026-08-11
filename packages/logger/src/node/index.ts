/**
 * `@podium/logger/node` — the sinks that need a filesystem or a real stdout.
 *
 * ```ts
 * import { createLogger } from '@podium/logger'
 * import { createFileSink } from '@podium/logger/node'
 * ```
 *
 * THIS IS A SEPARATE ENTRYPOINT ON PURPOSE, and the separation is enforced
 * rather than agreed. `@podium/logger` (the barrel) is a declared browser
 * entrypoint in scripts/architecture-manifest.ts: scripts/check-boundaries.ts
 * walks its import closure and scripts/audit-browser-reach.ts bundles it for the
 * browser, and both refuse a `node:` specifier anywhere they can reach. So this
 * directory must stay UNREACHABLE from `../index.ts` — nothing here may be
 * re-exported there, and nothing in `../` may import from `./`. The dependency
 * points one way only: these sinks import the record shape and the sink
 * interface from the browser-safe core, never the reverse.
 *
 * The type space says the same thing twice: `../tsconfig.json` extends
 * `dom.json` and EXCLUDES this directory, while `../tsconfig.node.json` covers
 * exactly this directory with `@types/node`. A `node:fs` import that drifted
 * upstairs would stop compiling before any audit had to notice.
 */

export * from './file-sink'
export * from './stdout-sink'
