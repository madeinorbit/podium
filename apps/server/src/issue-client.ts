import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from './router'

export type IssueTrpc = ReturnType<typeof makeIssueClient>

/** Typed tRPC client over loopback HTTP. baseUrl e.g. http://localhost:18787 (no trailing /trpc). */
export function makeIssueClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] })
}
