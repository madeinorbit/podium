/**
 * THE HARNESS CONTEXT'S TYPES, ALONE (POD-6533).
 *
 * Plain data, so the contract surfaces that carry a context (SessionSpec, the
 * instrumentation destination, the observer input) can name it without
 * pulling the builder and the adapter registry into every package that reads
 * those surfaces. The builder lives in ./harness-context.ts.
 */
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessRoots } from './manifest.js'

/**
 * Machine level, from the inventory. Nothing account-specific.
 *
 * Machine facts (version and capability checks) use this plus the MACHINE
 * command env, never an account env. Leaves room for a later
 * `managed | external` provenance field.
 */
export interface HarnessInstallation {
  readonly kind: BuiltinHarnessKind
  /** Absolute path the inventory verified. Never a basename. */
  readonly executable: string
  /** Version the inventory read when it verified `executable`; `''` when the
   *  CLI printed none. */
  readonly version: string
  /** Command-environment generation the executable was resolved in. */
  readonly generation: number
}

/** Installation + account. Everything that touches a harness takes this. */
export interface HarnessContext {
  readonly installation: HarnessInstallation
  /** The account HOME: the daemon's credential home. */
  readonly home: string
  /** The account environment: what the child gets for this account. */
  readonly env: Readonly<Record<string, string>>
  /** Resolved once from the adapter's `roots` declaration. */
  readonly roots: Readonly<HarnessRoots>
}
