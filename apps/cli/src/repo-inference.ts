import type { IssueTrpc } from '@podium/issue-client'

/** Retry a failed lookup once for a server that is briefly unavailable. A
 * successful response with no matching repository is left to the caller. */
export async function inferRepoPath(client: IssueTrpc, path: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = (await client.repos.inferFromPath.query({ path })) as {
        repoPath: string | null
      }
      return result.repoPath ?? undefined
    } catch (err) {
      if (attempt > 0) {
        const cause = err instanceof Error ? err.message : String(err)
        throw new Error(
          `could not reach the server to find the repository for ${path}: ${cause}; retry or pass --repoPath`,
          { cause: err },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}
