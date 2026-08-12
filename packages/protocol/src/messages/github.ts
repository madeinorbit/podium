import { z } from 'zod'

/** Public GitHub CLI readiness. Authentication material never crosses this boundary. */
export const GitHubCliStatusWire = z.discriminatedUnion('state', [
  z.object({ state: z.literal('missing') }),
  z.object({ state: z.literal('logged-out') }),
  z.object({ state: z.literal('ready'), login: z.string().min(1).optional() }),
])
export type GitHubCliStatusWire = z.infer<typeof GitHubCliStatusWire>

/** A repository the current `gh` account may clone. */
export const GitHubRepositoryWire = z.object({
  nameWithOwner: z.string().min(3),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  url: z.string().url(),
  pushedAt: z.string().datetime().nullable(),
})
export type GitHubRepositoryWire = z.infer<typeof GitHubRepositoryWire>

/** Route-neutral server → daemon GitHub CLI operation. */
export const GitHubCliRequestMessage = z.object({
  type: z.literal('githubCliRequest'),
  requestId: z.string(),
  action: z.enum(['status', 'list', 'clone']),
  repository: z.string().optional(),
  destination: z.string().optional(),
})
export type GitHubCliRequestMessage = z.infer<typeof GitHubCliRequestMessage>

/** Every failure is a result so the onboarding surface can offer recovery immediately. */
export const GitHubCliResultMessage = z.object({
  type: z.literal('githubCliResult'),
  requestId: z.string(),
  status: GitHubCliStatusWire,
  repositories: z.array(GitHubRepositoryWire).optional(),
  path: z.string().optional(),
  error: z.string().optional(),
})
export type GitHubCliResultMessage = z.infer<typeof GitHubCliResultMessage>
