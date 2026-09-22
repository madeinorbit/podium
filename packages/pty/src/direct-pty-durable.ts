import type { DurableAdapter, DurableProcess } from './durable-process.js'
import { type DurableAttachment, spawnAgent } from './session.js'

const NOT_DURABLE = 'direct-pty test double: there is no durable host behind this session'

/**
 * A `DurableProcess` over a DIRECT pty, for TESTS ONLY (POD-4617).
 *
 * A daemon with no durable process refuses every spawn, so the raw-pty spawn
 * that used to be its silent `backend=none` fallback now exists only here, under
 * a name that says what it is. Suites that drive fixtures on a direct pty (the
 * deterministic Bun.Terminal path) inject this through the daemon's `durable`
 * seam. Nothing it starts survives its owner: `has` is always false, so a child
 * exit reads as the session's exit, exactly as the old fallback behaved.
 *
 * NOT a production door: `apps/daemon/src/durable-door.test.ts` keeps it off the
 * allow-list, so no production daemon file can import it. It reports itself as
 * the host kind only because `DurableKind` has no "not durable" member; nothing
 * that reads the kind reaches a terminal durable.
 */
export function directPtyDurableForTests(): DurableProcess {
  const live = new Map<string, DurableAttachment>()
  const refuse = (what: string) => (): Promise<never> => Promise.reject(new Error(`${NOT_DURABLE} (${what})`))
  const spawn: DurableAdapter['spawn'] = async (opts) => {
    if (opts.cols === undefined || opts.rows === undefined) {
      throw new Error(`${NOT_DURABLE}: a pty spawn needs geometry (label '${opts.label}')`)
    }
    const session = spawnAgent(
      {
        cmd: opts.cmd,
        cols: opts.cols,
        rows: opts.rows,
        ...(opts.args ? { args: opts.args } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.stripEnv ? { stripEnv: opts.stripEnv } : {}),
      },
      ...(opts.backend ? [opts.backend] : []),
    )
    live.set(opts.label, session)
    session.onExit(() => {
      if (live.get(opts.label) === session) live.delete(opts.label)
    })
    return session
  }
  const kill = async (label: string): Promise<void> => {
    const session = live.get(label)
    live.delete(label)
    session?.dispose()
  }
  const adapter: DurableAdapter = {
    kind: 'host',
    spawn,
    spawnHeadless: refuse('spawnHeadless'),
    attachHeadless: refuse('attachHeadless'),
    attach: refuse('attach'),
    steal: refuse('steal'),
    has: async () => false,
    kill,
    list: async () => [],
    socketPath: async () => undefined,
    waitForSocket: refuse('waitForSocket'),
    hasMasterSync: () => false,
    attachCommand: (target) => target,
  }
  return {
    backend: 'host',
    primary: adapter,
    all: [adapter],
    spawn,
    spawnHeadless: adapter.spawnHeadless,
    attachHeadless: adapter.attachHeadless,
    locate: async () => undefined,
    has: adapter.has,
    kill,
    list: adapter.list,
    hasMasterSync: adapter.hasMasterSync,
  }
}
