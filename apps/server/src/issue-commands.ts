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
      parentId: z.string().optional(),
    }),
    async run(c, a) {
      const i = (await c.issues.create.mutate({
        repoPath: a.repoPath as string,
        title: a.title as string,
        startNow: false,
        ...(a.description ? { description: a.description as string } : {}),
        ...(a.priority != null ? { priority: a.priority as number } : {}),
        ...(a.type ? { type: a.type as never } : {}),
        ...(a.parentId ? { parentId: a.parentId as string } : {}),
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
  {
    name: 'delete',
    summary: 'Delete an issue permanently (maintainer).',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      await c.issues.delete.mutate({ id: a.id as string })
      return `deleted ${a.id}`
    },
  },
  {
    name: 'label',
    summary: "Set an issue's labels (replaces): --labels a,b,c.",
    args: z.object({ id: z.string(), labels: z.string() }),
    async run(c, a) {
      const labels = String(a.labels)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const w = (await c.issues.setLabels.mutate({ id: a.id as string, labels })) as {
        labels: string[]
      }
      return `labels: ${w.labels.join(', ') || '(none)'}`
    },
  },
  {
    name: 'defer',
    summary: 'Defer an issue until a date (--until 2026-07-01).',
    args: z.object({ id: z.string(), until: z.string() }),
    async run(c, a) {
      await c.issues.defer.mutate({ id: a.id as string, until: a.until as string })
      return `deferred ${a.id} until ${a.until}`
    },
  },
  {
    name: 'undefer',
    summary: "Clear an issue's defer.",
    args: z.object({ id: z.string() }),
    async run(c, a) {
      await c.issues.defer.mutate({ id: a.id as string, until: null })
      return `undeferred ${a.id}`
    },
  },
  {
    name: 'needs-human',
    summary: 'Flag an issue as needing a human decision (--question optional).',
    args: z.object({ id: z.string(), question: z.string().optional() }),
    async run(c, a) {
      await c.issues.setNeedsHuman.mutate({ id: a.id as string, ...(a.question ? { question: a.question as string } : {}) })
      return `flagged ${a.id} for human`
    },
  },
  {
    name: 'clear-needs-human',
    summary: 'Clear the needs-human flag on an issue.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      await c.issues.clearNeedsHuman.mutate({ id: a.id as string })
      return `cleared needs-human on ${a.id}`
    },
  },
  {
    name: 'supersede',
    summary: 'Supersede <old> with <new>: --oldId --newId.',
    args: z.object({ oldId: z.string(), newId: z.string() }),
    async run(c, a) {
      await c.issues.supersede.mutate({ oldId: a.oldId as string, newId: a.newId as string })
      return `${a.oldId} superseded by ${a.newId}`
    },
  },
  {
    name: 'duplicate',
    summary: 'Mark <id> a duplicate of <canonicalId>.',
    args: z.object({ id: z.string(), canonicalId: z.string() }),
    async run(c, a) {
      await c.issues.duplicate.mutate({ id: a.id as string, canonicalId: a.canonicalId as string })
      return `${a.id} marked duplicate of ${a.canonicalId}`
    },
  },
  {
    name: 'dep-remove',
    summary: 'Remove a dependency: --fromId --toId [--type].',
    args: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
    async run(c, a) {
      await c.issues.depRemove.mutate({
        fromId: a.fromId as string,
        toId: a.toId as string,
        ...(a.type ? { type: a.type as string } : {}),
      })
      return `dep removed ${a.fromId} -> ${a.toId}`
    },
  },
  {
    name: 'reparent',
    summary: "Set/clear an issue's parent: --id --parentId (omit parentId to clear).",
    args: z.object({ id: z.string(), parentId: z.string().optional() }),
    async run(c, a) {
      await c.issues.reparent.mutate({
        id: a.id as string,
        parentId: (a.parentId as string) ?? null,
      })
      return a.parentId ? `${a.id} parented to ${a.parentId}` : `${a.id} unparented`
    },
  },
  {
    name: 'find-duplicates',
    summary: 'Find likely duplicate issues (Jaccard) [--threshold].',
    args: z.object({ ...optRepo, threshold: z.coerce.number().optional() }),
    async run(c, a) {
      const ds = (await c.issues.findDuplicates.query(a as never)) as {
        a: string
        b: string
        score: number
      }[]
      return ds.length
        ? ds.map((d) => `${d.a} ~ ${d.b} (${d.score.toFixed(2)})`).join('\n')
        : '(no duplicates)'
    },
  },
  {
    name: 'graph',
    summary: 'Dependency graph (nodes + edges).',
    args: z.object(optRepo),
    async run(c, a) {
      const g = (await c.issues.graph.query(a as { repoPath?: string })) as {
        nodes: { seq: number; title: string }[]
        edges: { from: string; to: string; type: string }[]
      }
      return `${g.nodes.length} nodes, ${g.edges.length} edges`
    },
  },
  {
    name: 'doctor',
    summary: 'Health check (cycles, dangling deps, lint/stale counts).',
    args: z.object(optRepo),
    async run(c, a) {
      const d = (await c.issues.doctor.query(a as { repoPath?: string })) as {
        cycles: string[][]
        danglingDeps: unknown[]
        lintCount: number
        staleCount: number
      }
      return `cycles: ${d.cycles.length}, dangling: ${d.danglingDeps.length}, lint: ${d.lintCount}, stale: ${d.staleCount}`
    },
  },
  {
    name: 'preflight',
    summary: 'Pre-PR check (ok if no cycles/dangling deps).',
    args: z.object(optRepo),
    async run(c, a) {
      const p = (await c.issues.preflight.query(a as { repoPath?: string })) as { ok: boolean }
      return p.ok ? 'preflight: OK' : 'preflight: FAIL (run doctor)'
    },
  },
  {
    name: 'stale',
    summary: 'Issues with no activity in N days (--days 30).',
    args: z.object({ ...optRepo, days: z.coerce.number().optional() }),
    async run(c, a) {
      const rows = (await c.issues.stale.query(a as never)) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(none stale)'
    },
  },
  {
    name: 'orphans',
    summary: 'Open issues referenced in commits (implemented-but-open).',
    args: z.object(repoArg),
    async run(c, a) {
      const rows = (await c.issues.orphans.query({ repoPath: a.repoPath as string })) as {
        seq: number
        title: string
        ref: string
      }[]
      return rows.length
        ? rows.map((r) => `#${r.seq} ${r.title} (${r.ref})`).join('\n')
        : '(no orphans)'
    },
  },
  {
    name: 'lint',
    summary: 'Issues missing template sections.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.lint.query(a as { repoPath?: string })) as {
        seq: number
        findings: string[]
      }[]
      return rows.length
        ? rows.map((r) => `#${r.seq}: ${r.findings.join('; ')}`).join('\n')
        : '(lint clean)'
    },
  },
  {
    name: 'count',
    summary: 'Counts grouped by stage/priority/type/assignee.',
    args: z.object(optRepo),
    async run(c, a) {
      const ct = (await c.issues.count.query(a as { repoPath?: string })) as {
        byStage: Record<string, number>
        byType: Record<string, number>
      }
      return `by stage: ${JSON.stringify(ct.byStage)}\nby type: ${JSON.stringify(ct.byType)}`
    },
  },
  {
    name: 'prime',
    summary: "Print this session's issue context (bound issue + children/blockers, or ready-work lobby).",
    args: z.object(optRepo),
    async run(c, a) {
      return (await c.issues.prime.query(a as { repoPath?: string })) as string
    },
  },
  {
    name: 'epic-status',
    summary: 'Epic completion: --id.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      const e = (await c.issues.epicStatus.query({ id: a.id as string })) as {
        childCount: number
        childDoneCount: number
        complete: boolean
      }
      return `${e.childDoneCount}/${e.childCount} done${e.complete ? ' (complete)' : ''}`
    },
  },
]
