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
 * command env, never an account env.
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
  /**
   * Podium installed it and updates it (a release folder the install ledger
   * names), or the person did (found on the command path or in the adapter's
   * known folders). docs/design/harness-managed-installs.md §6.1. A managed
   * installation only ever runs in a home Podium made (§4.2, M9).
   */
  readonly provenance: HarnessInstallationProvenance
}

/** Who put an installation on the machine (managed installs §6.1). */
export type HarnessInstallationProvenance = 'managed' | 'external'

/**
 * A Podium home the context runs in (credential management §10): the
 * harness's configuration directory for one credential, named by the
 * harness's own variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). The account HOME
 * stays as it is; only the harness's directory moves.
 */
export interface HarnessHomeRef {
  /** `<credentialId>:<harness>`. */
  readonly id: string
  readonly dir: string
  readonly variable: string
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
  /**
   * The Podium home this context runs in. Absent: the harness's own directory
   * (the `default` home). `env` and `roots` already follow it, and
   * `harnessChildEnv` sets its variable after every other layer.
   */
  readonly harnessHome?: HarnessHomeRef
}
