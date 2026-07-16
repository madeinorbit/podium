/**
 * @podium/telemetry — opt-in, two-tier anonymous telemetry [spec:SP-f933].
 *
 * Design: docs/internal/superpowers/specs/2026-07-16-telemetry-design.md
 * User-facing contract: docs/TELEMETRY.md (kept honest by docs-drift.test.ts).
 *
 * Nothing here collects, stores, or sends anything until a tier is explicitly
 * `on` in config.json. `schema.ts` is the source of truth for what may leave a
 * machine; everything else in the package exists to enforce it.
 */
export * from './consent'
export * from './emitter'
export * from './queue'
export * from './schema'
export * from './scrub'
