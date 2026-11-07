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
import { delimiter, dirname, join } from 'node:path'
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessExecutableSnapshot } from './executable-runtime.js'
import type { HarnessContext } from './harness-context-types.js'
import type { HarnessAccountScope, HarnessEnvironment, HarnessRoots } from './manifest.js'
import {
  harnessInstanceHomeEnv,
  harnessLoginReadEnv,
  manifestFor,
  serverDriverExecutable,
} from './registry.js'

export type { HarnessContext, HarnessInstallation } from './harness-context-types.js'

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
 * The context a session of `kind` on driver `driverId` runs under (POD-6546).
 *
 * The same as {@link harnessContext} for every driver that runs the harness's
 * own executable. A server alternative that declares a SECOND binary (today
 * opencode2's preview server) runs that binary instead: it is resolved in the
 * snapshot's command environment, exactly as the inventory's alternative probe
 * resolves it, and pinned on the context like any other installation. Its
 * version is `''` — the inventory verifies the harness's own executable, not
 * the alternative — so admission probes it live.
 *
 * Throws when the binary is not found: never a basename on the daemon's PATH.
 */
export function harnessDriverContext(
  snapshot: HarnessExecutableSnapshot,
  kind: BuiltinHarnessKind,
  home: string,
  driverId: string,
): HarnessContext {
  const binary = serverDriverExecutable(driverId)
  const manifest = manifestFor(kind)
  if (!binary || !manifest || manifest.inventory.executable.names.includes(binary)) {
    return harnessContext(snapshot, kind, home)
  }
  const environment = snapshot.commandEnvironment
  const executable = environment.resolve(binary)
  if (!executable) {
    throw new Error(
      `${driverId} needs ${binary}, which is not installed in command-environment generation ${environment.generation}`,
    )
  }
  const account = harnessAccount(kind, home, environment.env)
  return Object.freeze({
    installation: Object.freeze({
      kind,
      executable,
      version: '',
      generation: environment.generation,
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

/** The three env inputs a spawn path brings to {@link harnessChildEnv}. */
export interface HarnessChildEnvLayers {
  /**
   * `spec.env`: what the server put on the spawn frame for this session (the
   * managed account's credential, SP-6454 #216). The ONLY source of
   * "explicitly selected": a credential key found here survives the strip, the
   * same key from anywhere else does not.
   */
  readonly sessionEnv?: Readonly<Record<string, string>> | undefined
  /**
   * Harness wiring for this one launch: the adapter's own invocation env
   * (codex's MCP bearer, opencode's server credentials), instrumentation
   * output, a family's overlay. Never the command env.
   */
  readonly wiringEnv?: Readonly<Record<string, string>> | undefined
  /** Podium's per-session vars (relay pair, browser shim, session id,
   *  instance uuid). They beat everything above them. A `PATH` here is a
   *  PREFIX of Podium-owned folders (the browser shim's), placed after the
   *  Podium CLI's folder and ahead of the composed PATH; it never replaces it. */
  readonly podiumEnv?: Readonly<Record<string, string>> | undefined
}

/** A harness child's environment and the keys the process boundary deletes. */
export interface HarnessChildEnv {
  /** The whole child environment. The strip keys are already absent. */
  readonly env: Record<string, string>
  /**
   * The keys to delete AFTER any outer merge. A process layer that spreads its
   * own environment under `env` (the PTY and podium-host spawns spread the
   * daemon's) must delete these, or the daemon's copy comes back.
   */
  readonly strip: readonly string[]
}

/**
 * THE ONE ENVIRONMENT A HARNESS CHILD GETS (POD-6535, design §3.5).
 *
 * Every spawn path (terminal, engine, headless turn, buffered exec, attach
 * client) builds its child env here. Later layers win:
 *
 *  1. The context's env: the machine command env for this account
 *     ({@link harnessLoginReadEnv}).
 *  2. Inherited foreign credentials removed (see `strip`).
 *  3. `sessionEnv` (`spec.env`).
 *  4. `wiringEnv`, then the adapter's declared `environment.set`.
 *  5. The account `HOME` and the harness's instance selector, from
 *     `context.home`.
 *  6. `podiumEnv`, the desktop-owned `PODIUM_CLI_PATH`, and the PATH prefix:
 *     the Podium CLI's folder, then the account home's bin roots that PATH
 *     does not already hold.
 *
 * Strip rules (applied to the final env, and returned for the boundary):
 *  - `foreignCredentialEnv` keys are removed unless `sessionEnv` holds them.
 *  - `removeInherited` keys are removed whatever their source, `sessionEnv`
 *    included: a parent conversation's identity is never a session's choice.
 *
 * Provenance is read from `sessionEnv` and nowhere else (F10). A path that
 * asked "is this key in the env I composed?" would find an inherited key there
 * and keep it.
 */
export function harnessChildEnv(
  context: HarnessContext,
  layers: HarnessChildEnvLayers,
): HarnessChildEnv {
  const kind = context.installation.kind
  const manifest = manifestFor(kind)
  const sessionEnv = layers.sessionEnv ?? {}
  const strip = [
    ...new Set([
      ...(manifest?.inventory.foreignCredentialEnv ?? []).filter((key) => !(key in sessionEnv)),
      ...(manifest?.environment.removeInherited ?? []),
    ]),
  ]
  // Desktop-owned (SP-d6e8): the machine's binding, never one a credential or
  // an adapter supplies.
  const podiumCliPath = context.env.PODIUM_CLI_PATH?.trim()
  const { PATH: podiumPath, ...podiumVars } = layers.podiumEnv ?? {}
  const env: Record<string, string> = {
    ...context.env,
    ...sessionEnv,
    ...layers.wiringEnv,
    ...manifest?.environment.set,
    HOME: context.home,
    ...harnessInstanceHomeEnv(kind, context.home),
    ...podiumVars,
    ...(podiumCliPath ? { PODIUM_CLI_PATH: podiumCliPath } : {}),
  }
  for (const key of strip) delete env[key]
  env.PATH = childPath(env.PATH ?? '', context.home, podiumCliPath, podiumPath)
  return { env, strip }
}

/**
 * The Podium CLI's folder first, then Podium's own folders (the browser shim),
 * then the account home's install roots the PATH lacks, then PATH as it was. A
 * root PATH already holds keeps its place: the machine's own order is not
 * reshuffled, and a named instance's home, whose roots the machine PATH never
 * holds, still resolves first.
 */
function childPath(
  path: string,
  home: string,
  podiumCliPath: string | undefined,
  podiumPath: string | undefined,
): string {
  const entries = path.split(delimiter).filter(Boolean)
  const roots = [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.opencode', 'bin')]
  return [
    ...(podiumCliPath ? [dirname(podiumCliPath)] : []),
    ...(podiumPath ?? '').split(delimiter),
    ...roots.filter((root) => !entries.includes(root)),
    ...entries,
  ]
    .filter((entry, index, all) => entry && all.indexOf(entry) === index)
    .join(delimiter)
}
