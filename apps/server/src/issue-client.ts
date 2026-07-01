import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from './router'

export type IssueTrpc = ReturnType<typeof makeIssueClient>

/** Typed tRPC client for the issue tracker. baseUrl e.g. http://localhost:18787 (no trailing
 *  /trpc). Authorization isn't carried here: a caller who reaches /trpc is the operator (the
 *  login session gates that surface); constrained agents are relayed via their daemon. */
export function makeIssueClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${baseUrl}/trpc` })],
  })
}
