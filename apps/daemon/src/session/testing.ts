/**
 * Test seams for the Session/Terminal lifecycle (POD-4434). Production code
 * never imports this module.
 */

import type { SessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import type { DaemonContext } from '../control/context'
import { Terminal, type TerminalKind } from '../terminal/terminal.js'
import { SessionRegistry } from './registry.js'

/** A registry whose labels are fixed strings — tests never route the daemon's label function. */
export function testSessions(label = 'podium-test-label'): SessionRegistry {
  return new SessionRegistry({ labelFor: () => label })
}

/**
 * Hold a fake attachment as the session's Terminal, the way `wireBridge` holds
 * a real one: same factory, same slot, over the session's own screen.
 */
export function attachTestTerminal(
  ctx: Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  attachment: DurableAttachment,
  kind: TerminalKind = 'headed',
): Terminal {
  const owned = ctx.sessions.ensure(sessionId)
  const terminal = Terminal.attach(attachment, owned.screen(), { onFrame: () => {} }, { kind })
  owned.terminal = terminal
  return terminal
}
