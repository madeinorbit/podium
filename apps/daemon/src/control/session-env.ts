/**
 * SPAWN-ENV COMPOSITION, shared by the PTY launch path and the server-driver
 * hosts (POD-2247).
 *
 * This lives outside `session.ts` because the server-driver hosts need it and
 * `session.ts` imports their version probes — importing back the other way
 * would close a cycle. Nothing here may import daemon modules.
 */

import { delimiter, dirname, join } from 'node:path'
import { harnessInstanceHomeEnv, manifestFor } from '@podium/harness'
import type { AgentKind } from '@podium/model'

const HARNESS_COMPAT_ENV: Partial<Record<AgentKind, Record<string, string>>> = {
  codex: { CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1' },
}

/** Terminal-protocol compatibility required by both primary and attach TUIs. */
export function harnessCompatEnv(agentKind: AgentKind): Record<string, string> {
  return HARNESS_COMPAT_ENV[agentKind] ?? {}
}

/**
 * The credential vars this spawn must DELETE, not merely leave unset (POD-2296).
 *
 * A session's account is whatever its agent home is logged into. That holds only
 * if the harness never finds a competing credential in its environment — and the
 * daemon hands every child its own environment, so anything the daemon carries
 * (a developer's `ANTHROPIC_API_KEY` exported before `podium daemon`, a systemd
 * unit with an `-E` line, an inherited login shell) reaches the agent and wins.
 * The result bills an account nobody chose, on a machine whose Podium readout
 * still names the account on disk. The manifest declares which vars can do that
 * to which CLI; this only decides WHICH of them to drop for one spawn.
 *
 * TWO KINDS OF KEY, AND ONLY ONE IS A LEAK. A key the server put on the spawn
 * frame IS the account Podium resolved for this session (a managed account,
 * #216) — deliberate, and preserved by the `key in sessionEnv` exemption. What
 * is dropped is only what the child would have inherited. The removal must
 * happen after the merge (`stripEnv`, `delete`) rather than by blanking: an
 * empty `ANTHROPIC_API_KEY` is still a set one to a CLI that tests presence.
 *
 * Unknown harness ids and `shell` declare nothing and so strip nothing. For a
 * shell that is the decision, not an oversight: a shell session is the operator
 * at their own prompt (the same line POD-1375 draws for agent identity), and
 * silently removing their key from their terminal would break work they meant
 * to do.
 *
 * THE OTHER HALF OF THIS RULE ALREADY EXISTED, which is how the gap survived:
 * every SERVER-DRIVER host strips its own credentials at its own spawn
 * (`STRIPPED_CODEX_CREDENTIALS`, `STRIPPED_PROVIDER_KEYS`, grok's `XAI_API_KEY`),
 * and those lists stay theirs — codex's is deliberately wider than a manifest
 * declaration, reaching org and base-url too. What had no equivalent was the
 * TERMINAL family, where `claude` runs.
 */
export function foreignCredentialEnv(
  agentKind: AgentKind | string | undefined,
  sessionEnv?: Readonly<Record<string, string>>,
): string[] {
  const declared = agentKind ? manifestFor(agentKind)?.inventory.foreignCredentialEnv : undefined
  return (declared ?? []).filter((key) => !(sessionEnv && key in sessionEnv))
}

/** Parent-harness controls that must never describe a Podium-owned child. */
export function harnessChildStripEnv(
  agentKind: AgentKind | string | undefined,
  sessionEnv?: Readonly<Record<string, string>>,
): string[] {
  const controls = agentKind ? manifestFor(agentKind)?.environment.removeInherited : undefined
  return [...new Set([...foreignCredentialEnv(agentKind, sessionEnv), ...(controls ?? [])])]
}

/**
 * Redirect a harness-specific state selector into the named instance home.
 *
 * DELEGATED, NOT REIMPLEMENTED (POD-2692). The same selector now composes the
 * environment the inventory's login probe and the spawn gate read under
 * (`harnessLoginReadEnv`), and the whole defect this fixes was two readers of one
 * declaration quietly diverging. One implementation is what keeps the child and
 * the readout describing the same account.
 */
export function harnessInstanceEnv(
  agentKind: AgentKind | string | undefined,
  homeDir?: string,
): Record<string, string> {
  return harnessInstanceHomeEnv(agentKind, homeDir)
}

/** Merge the server-resolved session env (managed credentials, #216) under
 *  Podium's own per-session bindings. Podium's win a collision on purpose: an
 *  injected credential must never be able to shadow the agent-relay wiring.
 *  The result is an OVERLAY — the PTY layer layers it over the full process.env. */
export function spawnEnv(
  opts: {
    sessionEnv?: Readonly<Record<string, string>>
    harnessEnv?: Readonly<Record<string, string>>
    podiumEnv: Readonly<Record<string, string>>
  },
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const podiumCliPath = processEnv.PODIUM_CLI_PATH?.trim()
  const merged: Record<string, string> = {
    ...(opts.sessionEnv ?? {}),
    ...(opts.harnessEnv ?? {}),
    ...opts.podiumEnv,
    // The desktop owns this binding. Managed credentials and harness adapters
    // cannot redirect agents to a stale or unrelated Podium CLI. [spec:SP-d6e8]
    ...(podiumCliPath ? { PODIUM_CLI_PATH: podiumCliPath } : {}),
  }
  if (podiumCliPath) {
    // The runtime has already recovered the machine's command environment. Keep
    // the desktop-owned CLI above it without deriving a second PATH from HOME.
    const inherited = merged.PATH ?? processEnv.PATH ?? ''
    merged.PATH = [dirname(podiumCliPath), ...inherited.split(delimiter)]
      .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
      .join(delimiter)
  }
  return merged
}

/**
 * The FULL env a server-driver child is spawned with (POD-2247).
 *
 * The PTY path hands `spawnEnv`'s overlay to a layer that spreads `process.env`
 * underneath it; a server driver's `spawn()` REPLACES the child env outright,
 * so the daemon env is spread here and the same overlay wins on top. `HOME` is
 * the instance's agent home whenever the daemon has one (`ctx.homeDir`) — a
 * child left on the daemon's own `HOME` reads and writes the operator's REAL
 * auth files and session stores from inside a supposedly isolated instance
 * (found live: an isolated grok session refreshed the real ~/.grok credentials
 * within seconds of spawn).
 *
 * Which exec class gets which env — the decision this module records:
 *   - AGENT CHILDREN (`opencode serve`, `codex app-server`, `grok agent stdio`)
 *     and the attach-TUI clients: THIS composition. Instance `HOME`, and the
 *     same `PATH` derivation the PTY path applies, so a harness installed only
 *     under the instance home resolves.
 *   - VERSION PROBES (`<binary> --version`): the daemon's own env, unchanged.
 *     They answer "what can this MACHINE run", the same question inventory
 *     asks, and read no per-user auth or session state. Some CLIs still create
 *     caches or temp directories under that HOME; this policy deliberately
 *     distinguishes those probes from the long-lived agent children above.
 *   - `systemctl` / `systemd-run` SCOPE MANAGEMENT: the daemon's own env — it
 *     talks to the daemon's user manager and must keep its `XDG_RUNTIME_DIR`.
 *     (`systemd-run --scope` execs the agent child with the env passed to it,
 *     so the wrapped child still gets this composition.)
 */
export function serverChildEnv(input: {
  /** Harness whose inherited controls and state selector this child reads. */
  agentKind: AgentKind
  /** `ctx.homeDir` — the instance agent home. Absent = default instance; the
   *  child keeps the daemon's HOME while still dropping harness controls. */
  homeDir?: string
  /** The server-resolved session env off the spawn frame (managed credentials). */
  sessionEnv?: Readonly<Record<string, string>>
  /** Driver-composed config env (e.g. codex MCP config). Wins over sessionEnv,
   *  loses to the instance HOME — the same precedence the PTY path gives its
   *  three layers. */
  harnessEnv?: Readonly<Record<string, string>>
  /** Immutable daemon ownership stamp for orphan attribution. */
  instanceUuid?: string
  /** Exact Podium session this child serves. */
  sessionId?: string
}, processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...processEnv,
    ...spawnEnv({
      ...(input.sessionEnv ? { sessionEnv: input.sessionEnv } : {}),
      ...(input.harnessEnv ? { harnessEnv: input.harnessEnv } : {}),
      podiumEnv: {
        ...(input.instanceUuid ? { PODIUM_INSTANCE_UUID: input.instanceUuid } : {}),
        ...(input.sessionId ? { PODIUM_SESSION_ID: input.sessionId } : {}),
        ...(input.homeDir
          ? { HOME: input.homeDir, ...harnessInstanceEnv(input.agentKind, input.homeDir) }
          : {}),
      },
    }, processEnv),
  }
  for (const key of harnessChildStripEnv(input.agentKind, input.sessionEnv)) delete env[key]
  if (!input.homeDir) return env

  // Server-driver spawn() replaces the child env and does not receive the PTY
  // runtime's resolved command environment. Give isolated children the instance
  // install roots, while a desktop-owned Podium CLI remains the first lookup.
  const podiumCliPath = env.PODIUM_CLI_PATH?.trim()
  const inherited = env.PATH ?? ''
  env.PATH = [
    ...(podiumCliPath ? [dirname(podiumCliPath)] : []),
    join(input.homeDir, '.local', 'bin'),
    join(input.homeDir, '.bun', 'bin'),
    join(input.homeDir, '.opencode', 'bin'),
    ...inherited.split(delimiter),
  ]
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
    .join(delimiter)
  return env
}

/**
 * The explicit overlay a headless turn's child runs under (moved from
 * headless-drivers.ts, POD-4614: headless turns run under podium-host now,
 * and this is the one piece of their spawn that is the daemon's decision).
 *
 * Three inputs, and the order between them is load-bearing:
 *  - `commandEnv` — the machine's recovered command environment. Its `HOME` is
 *    `commandEnvironment.machineHome`, the OPERATOR account home.
 *  - `specEnv` — the instance-owned child environment (the headless driver's
 *    `sessionEnv` port). It is built ON TOP of `commandEnv`, and the keys where
 *    the two differ are the ones the instance decided: `HOME` (the named
 *    instance's agent home), the agent-relay routing, the Podium CLI binding.
 *  - `execEnv` — what the harness adapter bound for this exact invocation.
 *    `bindHarnessExec` folds `commandEnv` into it (executable-runtime.ts
 *    `effectiveEnv`), so it too carries the machine `HOME` alongside genuinely
 *    per-turn keys like codex's MCP bearer (POD-1021).
 *
 * Letting `execEnv` win outright put the machine `HOME` back on the child. On a
 * named instance the harness then wrote its transcript under the operator
 * account home while the reader resolved the file under the instance's agent
 * home (control/transcripts.ts `sourceForRead`), and every `sessions.read`
 * answered empty — the whole conversation, prompt and answer included, not one
 * item type (POD-3059). `claude-code` declares no `instanceHome` selector, so
 * the trailing {@link harnessInstanceEnv} layer cannot catch it: for that
 * harness `HOME` alone decides where the record lands.
 *
 * So the adapter contributes the keys the instance did not decide, and never
 * overrides the ones it did.
 */
export function headlessSpawnEnv(input: {
  specEnv?: Readonly<Record<string, string>>
  execEnv?: Readonly<Record<string, string>>
  commandEnv: Readonly<Record<string, string>>
}): Record<string, string> {
  const base = input.specEnv ?? input.commandEnv
  const instanceOwned = Object.entries(base).filter(
    ([key, value]) => input.commandEnv[key] !== value,
  )
  return { ...base, ...input.execEnv, ...Object.fromEntries(instanceOwned) }
}

/**
 * The complete environment for one hosted headless turn, and what to strip at
 * the process boundary. Headless turns are another way to launch the same
 * CLI, so the manifest's stored-login precedence applies exactly as it does
 * to terminal and server-driver children (POD-2296): explicit per-turn values
 * are managed credentials Podium selected and win; only inherited daemon
 * values are removed. The harness-specific state selector stays LAST: it must
 * follow the instance home even against everything above it.
 */
export function headlessTurnEnv(input: {
  agent: AgentKind | string
  specEnv?: Readonly<Record<string, string>>
  execEnv?: Readonly<Record<string, string>>
  envOverlay?: Readonly<Record<string, string>>
  commandEnv: Readonly<Record<string, string>>
}): { env: Record<string, string>; stripEnv: string[] } {
  // The family's overlay is adapter-side env like `execEnv`: it adds what the
  // child needs, and never overrides a key the instance decided.
  const execEnv = { ...input.execEnv, ...input.envOverlay }
  const env = {
    ...headlessSpawnEnv({
      ...(input.specEnv ? { specEnv: input.specEnv } : {}),
      ...(Object.keys(execEnv).length > 0 ? { execEnv } : {}),
      commandEnv: input.commandEnv,
    }),
    ...harnessInstanceEnv(input.agent, input.specEnv?.HOME),
  }
  return { env, stripEnv: harnessChildStripEnv(input.agent, env) }
}
