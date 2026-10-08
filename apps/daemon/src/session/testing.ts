/**
 * Test seams for the Session/Terminal lifecycle (POD-4434). Production code
 * never imports this module.
 */

import type {
  AgentSessionHandle,
  SessionSpec,
  TerminalLaunch,
  TerminalLaunched,
} from '@podium/harness/driver/host'
import type { ResumeRef, SessionId } from '@podium/model'
import type {
  DurableAttachment,
  DurableProcess,
  DurableSpawnOptions,
} from '@podium/process/durable'
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
  const terminal = Terminal.attach(attachment, owned, { onFrame: () => {} }, { kind })
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
  spawn: (opts: DurableSpawnOptions & { cols: number; rows: number }) => unknown,
): DurableProcess {
  const refuse = (): Promise<never> => Promise.reject(new Error('stubDurable: not a durable host'))
  const adapter = {
    kind: 'host' as const,
    // A terminal spawn always carries geometry (the adapters refuse one without).
    spawn: async (opts: DurableSpawnOptions) =>
      spawn(opts as DurableSpawnOptions & { cols: number; rows: number }) as DurableAttachment,
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

/**
 * The machine runtime's terminal source as the daemon drives it (POD-5814),
 * for tests that stop short of a real terminal family: `create`/`resume`
 * launch through the daemon's own terminal host port from the spec, register
 * a minimal terminal handle, and announce — the family's order. The launch is
 * passed in so this module never loads `control/session` ahead of a test's
 * mocks.
 */
export function testTerminalRuntime(
  ctx: DaemonContext,
  launch: (ctx: DaemonContext, input: TerminalLaunch) => Promise<TerminalLaunched>,
): {
  create(spec: SessionSpec, sessionId: SessionId): Promise<AgentSessionHandle>
  resume(ref: ResumeRef, spec: SessionSpec, sessionId: SessionId): Promise<AgentSessionHandle>
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  has(sessionId: SessionId): boolean
  clearTerminal(sessionId: SessionId): void
} {
  const handles = new Map<SessionId, AgentSessionHandle>()
  const createWithId = async (sessionId: SessionId, spec: SessionSpec, resume?: ResumeRef) => {
    const launched = await launch(ctx, {
      sessionId,
      spec,
      instrumentation: { args: [] },
      ...(resume ? { resume } : {}),
    })
    const handle = {
      binding: {
        sessionId,
        harness: spec.harness,
        family: 'terminal',
        driver: spec.selection.preference,
      },
    } as AgentSessionHandle
    handles.set(sessionId, handle)
    launched.announce()
    return handle
  }
  return {
    create: (spec, sessionId) => createWithId(sessionId, spec),
    resume: (ref, spec, sessionId) => createWithId(sessionId, spec, ref),
    handleFor: (sessionId) => handles.get(sessionId),
    has: (sessionId) => handles.has(sessionId),
    clearTerminal: (sessionId) => void handles.delete(sessionId),
  }
}
