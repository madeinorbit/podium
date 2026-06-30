import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from './router'

export type IssueTrpc = ReturnType<typeof makeIssueClient>

/** Typed tRPC client over loopback HTTP. baseUrl e.g. http://localhost:18787 (no trailing /trpc).
 *  Optional `cred` attaches the issue-tracker role credentials on every request: the maintainer
 *  `token` (→ `x-podium-issue-token`) and/or the caller's `cwd` (→ `x-podium-issue-cwd`, which the
 *  server maps to a worker role iff it's inside a live issue worktree). Absent creds ⇒ reader. */
export function makeIssueClient(baseUrl: string, cred?: { token?: string; cwd?: string }) {
  const headers = (): Record<string, string> => ({
    ...(cred?.token ? { 'x-podium-issue-token': cred.token } : {}),
    ...(cred?.cwd ? { 'x-podium-issue-cwd': cred.cwd } : {}),
  })
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${baseUrl}/trpc`, headers })],
  })
}
