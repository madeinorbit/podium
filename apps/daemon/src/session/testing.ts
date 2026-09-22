/**
 * Test seams for the Session/Terminal lifecycle (POD-4434). Production code
 * never imports this module.
 */

import type { SessionId } from '@podium/model'
import type { AbducoSpawnOptions, DurableAttachment, DurableProcess } from '@podium/process/durable'
import type { DaemonContext } from '../control/context'
import { Terminal, type TerminalKind } from '../terminal/terminal.js'
import { SessionRegistry } from './registry.js'

/** A bare registry — entries start unlabelled, exactly as in production. */
export function testSessions(): SessionRegistry {
  return new SessionRegistry()
}

/**
 * Hold a fake attachment as the session's Terminal, the way `wireBridge` holds
 * a real one: same factory, same slot (a predecessor is parked), over the
 * session's own screen.
 */
export function attachTestTerminal(
  ctx: Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  attachment: DurableAttachment,
  kind: TerminalKind = 'headed',
): Terminal {
  const owned = ctx.sessions.ensure(sessionId)
  const terminal = Terminal.attach(attachment, owned.screen(), { onFrame: () => {} }, { kind })
  owned.replaceTerminal(terminal)
  return terminal
}

/**
 * A terminal DurableProcess whose `spawn` hands the options to `spawn` and
 * returns what it returns — for unit tests that stop at the process layer. A
 * daemon context with no durable process refuses every spawn (POD-4617), so a
 * test that means to reach the pty must say which process stands in for it.
 * Nothing survives: `has` is false, so a stub exit reads as the session's exit.
 */
export function stubDurable(
  spawn: (opts: AbducoSpawnOptions & { cols: number; rows: number }) => unknown,
): DurableProcess {
  const refuse = (): Promise<never> => Promise.reject(new Error('stubDurable: not a durable host'))
  const adapter = {
    kind: 'host' as const,
    // A terminal spawn always carries geometry (the adapters refuse one without).
    spawn: async (opts: AbducoSpawnOptions) =>
      spawn(opts as AbducoSpawnOptions & { cols: number; rows: number }) as DurableAttachment,
    spawnHeadless: refuse,
    attachHeadless: refuse,
    attach: refuse,
    steal: refuse,
    has: async () => false,
    kill: async () => {},
    list: async () => [],
    socketPath: async () => undefined,
    waitForSocket: refuse,
    hasMasterSync: () => false,
    attachCommand: (target: string) => target,
  }
  return {
    backend: 'host',
    primary: adapter,
    all: [adapter],
    spawn: adapter.spawn,
    spawnHeadless: refuse,
    attachHeadless: refuse,
    locate: async () => undefined,
    has: adapter.has,
    kill: adapter.kill,
    list: adapter.list,
    hasMasterSync: adapter.hasMasterSync,
  }
}
