import { z } from 'zod'
import type { IssueTrpc } from './issue-client'

export interface IssueCommand {
  name: string
  summary: string
  args: z.ZodType
  run(client: IssueTrpc, args: Record<string, unknown>): Promise<string>
}

const repoArg = { repoPath: z.string() }
const optRepo = { repoPath: z.string().optional() }

// One-line summary of an issue for list/ready/blocked output.
function line(i: { seq: number; title: string; priority?: number; stage?: string }): string {
  const p = i.priority != null ? `P${i.priority} ` : ''
  const s = i.stage ? `[${i.stage}] ` : ''
  return `#${i.seq} ${p}${s}${i.title}`
}

export const ISSUE_COMMANDS: IssueCommand[] = [
  {
    name: 'ready',
    summary: 'List issues ready to work (open, not deferred, unblocked).',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.ready.query(a as { repoPath?: string })) as Array<
        Parameters<typeof line>[0]
      >
      return rows.length ? rows.map(line).join('\n') : '(no ready issues)'
    },
  },
  {
    name: 'blocked',
    summary: 'List issues blocked by an open dependency.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.blocked.query(a as { repoPath?: string })) as Array<
        Parameters<typeof line>[0]
      >
      return rows.length ? rows.map(line).join('\n') : '(no blocked issues)'
    },
  },
  {
    name: 'list',
    summary: 'List all issues in the repo.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.list.query(a as { repoPath?: string })) as Array<
        Parameters<typeof line>[0]
      >
      return rows.length ? rows.map(line).join('\n') : '(no issues)'
    },
  },
  {
    name: 'show',
    summary: 'Show one issue by id.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      const i = (await c.issues.get.query({ id: a.id as string })) as {
        seq: number
        title: string
        description: string
        stage: string
        priority: number
        ready: boolean
        blocked: boolean
      } | null
      if (!i) return `(no issue ${a.id})`
      return `#${i.seq} ${i.title}\nstage=${i.stage} P${i.priority} ready=${i.ready} blocked=${i.blocked}\n\n${i.description}`
    },
  },
  {
    name: 'create',
    summary: 'Create an issue. --title required; --priority --type --description optional.',
    args: z.object({
      ...repoArg,
      title: z.string().min(1),
      description: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      type: z.string().optional(),
    }),
    async run(c, a) {
      const i = (await c.issues.create.mutate({
        repoPath: a.repoPath as string,
        title: a.title as string,
        startNow: false,
        ...(a.description ? { description: a.description as string } : {}),
        ...(a.priority != null ? { priority: a.priority as number } : {}),
        ...(a.type ? { type: a.type as never } : {}),
      })) as { seq: number; title: string }
      return `created #${i.seq} ${i.title}`
    },
  },
  {
    name: 'update',
    summary: 'Update fields on an issue (--stage --priority --assignee --title …).',
    args: z.object({
      id: z.string(),
      stage: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      assignee: z.string().optional(),
      title: z.string().optional(),
    }),
    async run(c, a) {
      const patch: Record<string, unknown> = {}
      for (const k of ['stage', 'priority', 'assignee', 'title']) if (a[k] != null) patch[k] = a[k]
      const i = (await c.issues.update.mutate({ id: a.id as string, patch: patch as never })) as {
        seq: number
      }
      return `updated #${i.seq}`
    },
  },
  {
    name: 'close',
    summary: 'Close an issue (--reason done|superseded|duplicate|wontfix).',
    args: z.object({ id: z.string(), reason: z.string().optional() }),
    async run(c, a) {
      const i = (await c.issues.close.mutate({
        id: a.id as string,
        ...(a.reason ? { reason: a.reason as string } : {}),
      })) as { seq: number }
      return `closed #${i.seq}`
    },
  },
  {
    name: 'claim',
    summary: 'Claim an issue (set assignee + in_progress).',
    args: z.object({ id: z.string(), assignee: z.string() }),
    async run(c, a) {
      const i = (await c.issues.claim.mutate({
        id: a.id as string,
        assignee: a.assignee as string,
      })) as { seq: number }
      return `claimed #${i.seq}`
    },
  },
  {
    name: 'dep-add',
    summary: 'Add a dependency: <from> depends on <to> (--type blocks|related|…).',
    args: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
    async run(c, a) {
      await c.issues.depAdd.mutate({
        fromId: a.fromId as string,
        toId: a.toId as string,
        ...(a.type ? { type: a.type as string } : {}),
      })
      return `dep added ${a.fromId} -> ${a.toId}`
    },
  },
  {
    name: 'comment',
    summary: 'Add a comment to an issue (--author --body).',
    args: z.object({ id: z.string(), author: z.string(), body: z.string().min(1) }),
    async run(c, a) {
      await c.issues.addComment.mutate({
        id: a.id as string,
        author: a.author as string,
        body: a.body as string,
      })
      return `commented on ${a.id}`
    },
  },
  {
    name: 'search',
    summary: 'Search issues (--text --status --priority --type --label …).',
    args: z.object({
      ...optRepo,
      text: z.string().optional(),
      status: z.string().optional(),
      priority: z.coerce.number().int().optional(),
      type: z.string().optional(),
      label: z.string().optional(),
    }),
    async run(c, a) {
      const rows = (await c.issues.search.query(a as never)) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(no matches)'
    },
  },
  {
    name: 'stats',
    summary: 'Project stats (total/open/closed/ready/blocked/deferred).',
    args: z.object(optRepo),
    async run(c, a) {
      const s = (await c.issues.stats.query(a as { repoPath?: string })) as Record<string, number>
      return Object.entries(s)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    },
  },
]
