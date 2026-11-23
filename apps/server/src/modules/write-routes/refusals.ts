import { TRPCError } from '@trpc/server'
import type { PlainCommandRefusal } from '../plain-command/entry'

/** A plain front-door refusal as the tRPC error this transport has always answered. */
export function plainRefusalAsTrpcError(name: string, refusal: PlainCommandRefusal): TRPCError {
  switch (refusal.kind) {
    case 'unauthorized':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: `${name} is not permitted for this caller`,
      })
    case 'invalid':
      // The cause's message, exactly as tRPC's own input validation reports it.
      return new TRPCError({ code: 'BAD_REQUEST', cause: refusal.error })
  }
}
