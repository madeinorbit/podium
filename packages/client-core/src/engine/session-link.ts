/**
 * What a desktop session link says when the server cannot open it (POD-4637).
 * One sentence shape for the `?pane=` link and the jump-to-session action, so
 * the two entry points never describe the same answer differently.
 */
import type { SessionIdentifierResolution } from '@podium/protocol'

export function sessionLinkProblem(
  identifier: string,
  answer: Exclude<SessionIdentifierResolution, { kind: 'session' }>,
): string {
  const detail = answer.kind === 'ambiguous' ? answer.message : `no session matches '${identifier}'`
  return `Couldn't open session link — ${detail}`
}
