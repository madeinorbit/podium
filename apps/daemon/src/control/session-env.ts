/**
 * SPAWN-ENV COMPOSITION, shared by the PTY launch path and the server-driver
 * hosts (POD-2247).
 *
 * This lives outside `session.ts` because the server-driver hosts need it and
 * `session.ts` imports their version probes — importing back the other way
 * would close a cycle. Nothing here may import daemon modules.
 */

import { delimiter, dirname, join } from 'node:path'
import { manifestFor } from '@podium/harness'
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
 *     asks, and read no per-user auth or session state.
 *   - `systemctl` / `systemd-run` SCOPE MANAGEMENT: the daemon's own env — it
 *     talks to the daemon's user manager and must keep its `XDG_RUNTIME_DIR`.
 *     (`systemd-run --scope` execs the agent child with the env passed to it,
 *     so the wrapped child still gets this composition.)
 */
export function serverChildEnv(input: {
  /** `ctx.homeDir` — the instance agent home. Absent = default instance; the
   *  child keeps the daemon's env exactly as before. */
  homeDir?: string
  /** The server-resolved session env off the spawn frame (managed credentials). */
  sessionEnv?: Readonly<Record<string, string>>
  /** Driver-composed config env (e.g. codex MCP config). Wins over sessionEnv,
   *  loses to the instance HOME — the same precedence the PTY path gives its
   *  three layers. */
  harnessEnv?: Readonly<Record<string, string>>
}, processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...processEnv,
    ...spawnEnv({
      ...(input.sessionEnv ? { sessionEnv: input.sessionEnv } : {}),
      ...(input.harnessEnv ? { harnessEnv: input.harnessEnv } : {}),
      podiumEnv: input.homeDir ? { HOME: input.homeDir } : {},
    }, processEnv),
  }
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
