/**
 * THE HARNESS ACCESS CONTRACT'S VALUE (POD-6532,
 * docs/design/harness-access-contract.md §3.1).
 *
 * One plain-data answer to three questions about a harness for one account:
 * which executable runs, which environment it runs with, and which folders hold
 * its state. Built once from the inventory snapshot; nothing here reads the
 * daemon's own `process.env`, `PATH` or `homedir()`.
 *
 * Both types are PLAIN DATA, deliberately: a session can hold one, modules can
 * pass it around and tests can build one by hand. Behaviour lives in functions
 * that take a context.
 */
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessExecutableSnapshot } from './executable-runtime.js'
import type { HarnessAccountScope, HarnessEnvironment, HarnessRoots } from './manifest.js'
import { harnessLoginReadEnv, manifestFor } from './registry.js'

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

/**
 * Build the context for `kind` and the account living in `home`.
 *
 * `home` is the daemon's existing credential home (`credentialHome` in
 * apps/daemon host-runtime; `resolveManagementCredentialHome` for management).
 * `env` is {@link harnessLoginReadEnv} over the snapshot's command environment
 * — the documented "environment the child gets for this account" (POD-2692);
 * no second recipe. It sets the harness's instance selector from `home`, so an
 * ambient `CODEX_HOME` in the daemon never redirects an account's folders.
 *
 * Throws when the snapshot has no executable for `kind`: a context never falls
 * back to a basename on the daemon's PATH.
 */
export function harnessContext(
  snapshot: HarnessExecutableSnapshot,
  kind: BuiltinHarnessKind,
  home: string,
): HarnessContext {
  const executable = snapshot.executables.get(kind)
  if (!executable) {
    throw new Error(
      `harness ${kind} is not installed in command-environment generation ${snapshot.commandEnvironment.generation}`,
    )
  }
  const account = harnessAccount(kind, home, snapshot.commandEnvironment.env)
  return Object.freeze({
    installation: Object.freeze({
      kind,
      executable: executable.path,
      version: executable.version ?? '',
      generation: snapshot.commandEnvironment.generation,
    }),
    home: account.home,
    env: account.env,
    roots: account.roots,
  })
}

/**
 * THE ACCOUNT HALF OF {@link harnessContext} (POD-6534, design §3.3 "account
 * scope"), for reads that need no installation: quota, usage history,
 * credential files and transcripts outlive an uninstall, and a logged-in
 * account with no CLI on PATH still has a quota.
 *
 * The SAME recipe as the full context, so the two can never resolve different
 * folders: `env` is {@link harnessLoginReadEnv} over `machineEnv` (the
 * snapshot's command environment), `roots` the adapter's rule over that env.
 * Pass `{}` when no snapshot exists: the folders then come from `home` alone,
 * never from the daemon's own `process.env`.
 *
 * Throws for an unknown kind rather than guessing another harness's layout.
 */
export function harnessAccount(
  kind: BuiltinHarnessKind | string,
  home: string,
  machineEnv: HarnessEnvironment,
): HarnessAccountScope & { readonly env: Readonly<Record<string, string>> } {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`no manifest for harness ${kind}`)
  const env = Object.freeze(definedEnv(harnessLoginReadEnv(kind, home, machineEnv)))
  return Object.freeze({ home, env, roots: Object.freeze(manifest.roots(home, env)) })
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

/**
 * TRANSITIONAL (POD-6532): the adapter's folder rule for a caller that holds a
 * home and env but no context yet. POD-6533 and POD-6534 replace these
 * arguments with the session-pinned or account context; new code should take a
 * {@link HarnessContext} and read `roots` instead.
 *
 * Throws for an unknown kind rather than guessing another harness's layout.
 */
export function harnessRoots(
  kind: BuiltinHarnessKind | string,
  home: string,
  env: HarnessEnvironment,
): HarnessRoots {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`no manifest for harness ${kind}`)
  return manifest.roots(home, env)
}
