/**
 * `@podium/logger` — the one logging core every Podium runtime shares
 * [spec: docs/superpowers/specs/2026-08-11-logging-strategy-design.md].
 *
 * ```ts
 * import { createLogger } from '@podium/logger'
 * const log = createLogger('daemon:pty')
 * log.warn('resize dropped', { sessionId })
 * ```
 *
 * DEPENDENCY-FREE AND BROWSER-SAFE, and not by convention: this barrel is a
 * declared browser entrypoint in scripts/architecture-manifest.ts, and
 * scripts/audit-browser-reach.ts bundles it for the browser and refuses any
 * `node:`/`bun:` specifier the closure can reach. Node-only sinks (file,
 * rotation, stdout) belong behind a `./node` subpath, never here — one
 * `import { appendFileSync }` in this graph puts Node code in the web bundle,
 * where bun's browser target silently substitutes an empty object and the
 * client explodes at runtime instead of at build time.
 */

export * from './level-control'
export * from './levels'
export * from './logger'
export * from './record'
export * from './sinks'
export * from './sinks/console'
export * from './sinks/ring-buffer'
