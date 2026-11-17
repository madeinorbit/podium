/**
 * The session command plane's write on the plain path (ADR 12 D8, POD-6601).
 *
 * `sessions.uploadImage` puts bytes where the session will read them: held on
 * the server for an agent's next message (or a task not created yet), staged on
 * a headless agent's machine, or written to the session's machine by its
 * daemon. None of those is a synced row, so the upload is a plain command: the
 * front door, then the plane's own handler with its machine `use` gate, as the
 * caller. Its route keeps its schema and its answers (`trpc.ts`); the daemon's
 * TIMEOUT and INTERNAL_SERVER_ERROR shapes are the handler's, as POD-379 pins.
 */

import { sessionCommandPlane } from '@podium/commands'
import type { SessionId } from '@podium/model'
import { type PlainDefRegistration, trpcRequest } from '../plain-command/registry'
import { sessionCommandCtx } from './command-ctx'
import { dispatchSessionCommand, SESSION_COMMAND_HANDLERS } from './command-plane'

const UPLOAD = 'sessions.uploadImage'
const SWITCH = 'sessions.switchCredential'

export const SESSION_PLAIN_REGISTRATIONS: readonly PlainDefRegistration[] = [
  {
    name: UPLOAD,
    def: sessionCommandPlane.defs.uploadImage,
    handle: async (ctx, raw, source) => {
      const request = trpcRequest(ctx, source)
      const input = raw as Parameters<(typeof SESSION_COMMAND_HANDLERS)['uploadImage']>[1]
      const plane = await sessionCommandCtx(
        source.modules,
        request.capability,
        request.overrideScope,
      )
      const run = async () => await SESSION_COMMAND_HANDLERS.uploadImage(plane, input)
      // The session is resident while its bytes are placed (POD-6160 D2f): the
      // headless arm stages on the machine its live session names.
      const residency = source.modules.sessions.residency
      return residency
        ? await residency.withSession(input.sessionId as SessionId, UPLOAD, run)
        : await run()
    },
  },
  // Another credential for a session's conversation (credential management §9):
  // a record write, a `switch` event and a restart through revival, none of
  // them a synced write the caller makes; the switch's session writes are the
  // server's (relay.ts).
  {
    name: SWITCH,
    def: sessionCommandPlane.defs.switchCredential,
    handle: async (ctx, raw, source) => {
      const request = trpcRequest(ctx, source)
      const plane = await sessionCommandCtx(
        source.modules,
        request.capability,
        request.overrideScope,
      )
      return await dispatchSessionCommand(plane, 'switchCredential', raw)
    },
  },
]
