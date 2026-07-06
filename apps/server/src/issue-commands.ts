import { z } from 'zod'
import type { IssueTrpc } from './issue-client'

/** What a command returns: `text` is the human rendering; `data` is the structured
 *  payload (the tRPC result) that `--json` and MCP structured output serialize. */
export interface IssueCommandResult {
  text: string
  data?: unknown
}

export interface IssueCommand {
  name: string
  summary: string
  args: z.ZodType
  /** Positional argv words mapped to these arg keys in order (flags still win),
   *  so `podium issue start 10` ≡ `podium issue start --id 10`. */
  positionals?: string[]
  run(client: IssueTrpc, args: Record<string, unknown>): Promise<IssueCommandResult>
}

const repoArg = { repoPath: z.string() }
const optRepo = { repoPath: z.string().optional() }

/** Issue references accept the internal `iss_…` id or the display seq the CLI prints
 *  (`10` / `#10`); MCP callers may pass the seq as a number. Resolution happens
 *  server-side (IssueService.resolveRef). */
const idArg = z.union([z.string(), z.number()]).transform((v) => String(v))

// One-line summary of an issue for list/ready/blocked output.
function line(i: { seq: number; title: string; priority?: number; stage?: string }): string {
  const p = i.priority != null ? `P${i.priority} ` : ''
  const s = i.stage ? `[${i.stage}] ` : ''
  return `#${i.seq} ${p}${s}${i.title}`
}

type Row = Parameters<typeof line>[0]
const listResult = (rows: Row[], empty: string): IssueCommandResult => ({
  text: rows.length ? rows.map(line).join('\n') : empty,
  data: rows,
})

export const ISSUE_COMMANDS: IssueCommand[] = [
  {
    name: 'ready',
    summary: 'List issues ready to work (open, not deferred, unblocked).',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.ready.query(a as { repoPath?: string })) as Row[]
      return listResult(rows, '(no ready issues)')
    },
  },
  {
    name: 'blocked',
    summary: 'List issues blocked by an open dependency.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.blocked.query(a as { repoPath?: string })) as Row[]
      return listResult(rows, '(no blocked issues)')
    },
  },
  {
    name: 'list',
    summary: 'List all issues in the repo.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.list.query(a as { repoPath?: string })) as Row[]
      return listResult(rows, '(no issues)')
    },
  },
  {
    name: 'show',
    summary: 'Show one issue: show <id>.',
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.get.query({ id: a.id as string })) as {
        id: string
        seq: number
        title: string
        description: string
        stage: string
        priority: number
        ready: boolean
        blocked: boolean
        assignee?: string | null
        needsHuman?: boolean
        humanQuestion?: string | null
        labels?: string[]
        worktreePath?: string | null
        branch?: string | null
        defaultAgent?: string | null
        defaultModel?: string | null
        defaultEffort?: string | null
      } | null
      if (!i) throw new Error(`unknown issue ${a.id}`)
      const meta = [
        `stage=${i.stage} P${i.priority} ready=${i.ready} blocked=${i.blocked}`,
        i.assignee ? `assignee=${i.assignee}` : null,
        i.defaultAgent || i.defaultModel || i.defaultEffort
          ? `agent=${i.defaultAgent ?? 'auto'} model=${i.defaultModel ?? 'auto'} effort=${i.defaultEffort ?? 'auto'}`
          : null,
        i.labels?.length ? `labels=${i.labels.join(',')}` : null,
        i.branch ? `branch=${i.branch}` : null,
        i.needsHuman ? `NEEDS HUMAN${i.humanQuestion ? `: ${i.humanQuestion}` : ''}` : null,
      ]
        .filter(Boolean)
        .join('\n')
      return { text: `#${i.seq} ${i.title}\n${meta}\n\n${i.description}`, data: i }
    },
  },
  {
    name: 'create',
    summary: 'Create an issue. --title required; --description --priority --type --parentId --agent --model --effort --start optional.',
    args: z.object({
      ...repoArg,
      title: z.string().min(1),
      description: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      type: z.string().optional(),
      parentId: idArg.optional(),
      agent: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
      start: z.boolean().optional(),
    }),
    async run(c, a) {
      const i = (await c.issues.create.mutate({
        repoPath: a.repoPath as string,
        title: a.title as string,
        startNow: a.start === true,
        ...(a.description ? { description: a.description as string } : {}),
        ...(a.priority != null ? { priority: a.priority as number } : {}),
        ...(a.type ? { type: a.type as never } : {}),
        ...(a.parentId ? { parentId: a.parentId as string } : {}),
        ...(a.agent ? { defaultAgent: a.agent as string } : {}),
        ...(a.model ? { defaultModel: a.model as string } : {}),
        ...(a.effort ? { defaultEffort: a.effort as string } : {}),
      })) as { seq: number; title: string; worktreePath?: string | null }
      const started = a.start === true && i.worktreePath ? ` (started in ${i.worktreePath})` : ''
      return { text: `created #${i.seq} ${i.title}${started}`, data: i }
    },
  },
  {
    name: 'start',
    summary: 'Start an issue: create its worktree+branch, claim it, spawn its agent. start <id> [--agent claude-code]. Model/effort come from the issue (set via create/update --model/--effort).',
    args: z.object({ id: idArg, agent: z.string().min(1).optional() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.start.mutate({
        id: a.id as string,
        ...(a.agent ? { agentKind: a.agent as string } : {}),
      })) as {
        seq: number
        worktreePath?: string | null
        branch?: string | null
      }
      return { text: `started #${i.seq} (${i.branch ?? '?'} @ ${i.worktreePath ?? '?'})`, data: i }
    },
  },
  {
    name: 'update',
    summary: 'Update fields on an issue (--stage --priority --assignee --title --description --type --agent --model --effort …).',
    args: z.object({
      id: idArg,
      stage: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      assignee: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.string().optional(),
      agent: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const patch: Record<string, unknown> = {}
      for (const k of ['stage', 'priority', 'assignee', 'title', 'description', 'type'])
        if (a[k] != null) patch[k] = a[k]
      if (a.agent != null) patch.defaultAgent = a.agent
      if (a.model != null) patch.defaultModel = a.model
      if (a.effort != null) patch.defaultEffort = a.effort
      const i = (await c.issues.update.mutate({ id: a.id as string, patch: patch as never })) as {
        seq: number
      }
      return { text: `updated #${i.seq}`, data: i }
    },
  },
  {
    name: 'close',
    summary: 'Close an issue: close <id> [--reason done|superseded|duplicate|wontfix] [--note "handoff"].',
    args: z.object({
      id: idArg,
      reason: z.string().optional(),
      note: z.string().optional(),
      author: z.string().default('agent'),
    }),
    positionals: ['id'],
    async run(c, a) {
      // Completion note first: it must land even if close then fails, and the
      // close broadcast should follow the note so watchers read a complete issue.
      if (a.note) {
        await c.issues.addComment.mutate({
          id: a.id as string,
          author: a.author as string,
          body: `[completion-note] ${a.note as string}`,
        })
      }
      const i = (await c.issues.close.mutate({
        id: a.id as string,
        ...(a.reason ? { reason: a.reason as string } : {}),
      })) as { seq: number }
      return { text: `closed #${i.seq}${a.note ? ' (completion note recorded)' : ''}`, data: i }
    },
  },
  {
    name: 'claim',
    summary: 'Claim an issue (set assignee + in_progress): claim <id> --assignee me.',
    args: z.object({ id: idArg, assignee: z.string() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.claim.mutate({
        id: a.id as string,
        assignee: a.assignee as string,
      })) as { seq: number }
      return { text: `claimed #${i.seq}`, data: i }
    },
  },
  {
    name: 'archive',
    summary: 'Archive an issue: archive <id>.',
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.archive.mutate({ id: a.id as string })) as { seq: number }
      return { text: `archived #${i.seq}`, data: i }
    },
  },
  {
    name: 'action',
    summary:
      'Run a git action on an issue: action <id> <kind: rebase|pr|merge|integrate>. integrate (epics only) rebuilds the integration branch from closed children — local-only, never merges to the parent branch.',
    args: z.object({ id: idArg, kind: z.enum(['rebase', 'pr', 'merge', 'integrate']) }),
    positionals: ['id', 'kind'],
    async run(c, a) {
      // integrate is its own local-only proc (like cleanup): it must never be
      // hub-forwarded, while the other kinds go through the forwarding action proc.
      const r = (a.kind === 'integrate'
        ? await c.issues.integrate.mutate({ id: a.id as string })
        : await c.issues.action.mutate({
            id: a.id as string,
            kind: a.kind as 'rebase' | 'pr' | 'merge',
          })) as { ok: boolean; output: string }
      return { text: `${a.kind}: ${r.ok ? 'OK' : 'FAILED'}\n${r.output}`.trim(), data: r }
    },
  },
  {
    name: 'cleanup',
    summary:
      "Remove a closed issue's worktree and delete its merged branch: cleanup <id>. Guarded: refuses unless the issue is closed, the branch is fully merged into its parent, and the worktree is clean (never --force / -D).",
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const r = (await c.issues.cleanup.mutate({ id: a.id as string })) as {
        ok: boolean
        output: string
      }
      return { text: `cleanup: ${r.ok ? 'OK' : 'REFUSED'}\n${r.output}`.trim(), data: r }
    },
  },
  {
    name: 'add-session',
    summary: "Spawn another agent session in a started issue's worktree: add-session <id> [--agent claude-code]. Model/effort follow the issue defaults (update --model/--effort).",
    args: z.object({ id: idArg, agent: z.string().optional() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.addSession.mutate({
        id: a.id as string,
        ...(a.agent ? { agentKind: a.agent as string } : {}),
      })) as { seq: number }
      return { text: `session added to #${i.seq}`, data: i }
    },
  },
  {
    name: 'add-shell',
    summary: "Spawn a shell in a started issue's worktree: add-shell <id>.",
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.addShell.mutate({ id: a.id as string })) as { seq: number }
      return { text: `shell added to #${i.seq}`, data: i }
    },
  },
  {
    name: 'dep-add',
    summary: 'Add a dependency, <from> depends on <to>: dep-add <fromId> <toId> [--type blocks|related|discovered-from|…].',
    args: z.object({ fromId: idArg, toId: idArg, type: z.string().optional() }),
    positionals: ['fromId', 'toId'],
    async run(c, a) {
      const i = (await c.issues.depAdd.mutate({
        fromId: a.fromId as string,
        toId: a.toId as string,
        ...(a.type ? { type: a.type as string } : {}),
      })) as unknown
      return { text: `dep added ${a.fromId} -> ${a.toId}`, data: i }
    },
  },
  {
    name: 'comment',
    summary: 'Add a comment: comment <id> --body "…" [--author name].',
    args: z.object({ id: idArg, author: z.string().default('agent'), body: z.string().min(1) }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.addComment.mutate({
        id: a.id as string,
        author: a.author as string,
        body: a.body as string,
      })) as { seq: number }
      return { text: `commented on #${i.seq}`, data: i }
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
      const rows = (await c.issues.search.query(a as never)) as Row[]
      return listResult(rows, '(no matches)')
    },
  },
  {
    name: 'stats',
    summary: 'Project stats (total/open/closed/ready/blocked/deferred).',
    args: z.object(optRepo),
    async run(c, a) {
      const s = (await c.issues.stats.query(a as { repoPath?: string })) as Record<string, number>
      return {
        text: Object.entries(s)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
        data: s,
      }
    },
  },
  {
    name: 'delete',
    summary: 'Delete an issue permanently (maintainer): delete <id>.',
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const r = (await c.issues.delete.mutate({ id: a.id as string })) as unknown
      return { text: `deleted ${a.id}`, data: r }
    },
  },
  {
    name: 'label',
    summary: "Set an issue's labels (replaces): label <id> --labels a,b,c.",
    args: z.object({ id: idArg, labels: z.string() }),
    positionals: ['id'],
    async run(c, a) {
      const labels = String(a.labels)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const w = (await c.issues.setLabels.mutate({ id: a.id as string, labels })) as {
        labels: string[]
      }
      return { text: `labels: ${w.labels.join(', ') || '(none)'}`, data: w }
    },
  },
  {
    name: 'defer',
    summary: 'Defer an issue until a date: defer <id> --until 2026-07-01.',
    args: z.object({ id: idArg, until: z.string() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.defer.mutate({
        id: a.id as string,
        until: a.until as string,
      })) as unknown
      return { text: `deferred ${a.id} until ${a.until}`, data: i }
    },
  },
  {
    name: 'undefer',
    summary: "Clear an issue's defer: undefer <id>.",
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.defer.mutate({ id: a.id as string, until: null })) as unknown
      return { text: `undeferred ${a.id}`, data: i }
    },
  },
  {
    name: 'needs-human',
    summary: 'Flag an issue as needing a human decision: needs-human <id> [--question "…"].',
    args: z.object({ id: idArg, question: z.string().optional() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.setNeedsHuman.mutate({
        id: a.id as string,
        ...(a.question ? { question: a.question as string } : {}),
      })) as unknown
      return { text: `flagged ${a.id} for human`, data: i }
    },
  },
  {
    name: 'clear-needs-human',
    summary: 'Clear the needs-human flag: clear-needs-human <id>.',
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.clearNeedsHuman.mutate({ id: a.id as string })) as unknown
      return { text: `cleared needs-human on ${a.id}`, data: i }
    },
  },
  {
    name: 'supersede',
    summary: 'Supersede <old> with <new>: supersede <oldId> <newId>.',
    args: z.object({ oldId: idArg, newId: idArg }),
    positionals: ['oldId', 'newId'],
    async run(c, a) {
      const i = (await c.issues.supersede.mutate({
        oldId: a.oldId as string,
        newId: a.newId as string,
      })) as unknown
      return { text: `${a.oldId} superseded by ${a.newId}`, data: i }
    },
  },
  {
    name: 'duplicate',
    summary: 'Mark a duplicate: duplicate <id> <canonicalId>.',
    args: z.object({ id: idArg, canonicalId: idArg }),
    positionals: ['id', 'canonicalId'],
    async run(c, a) {
      const i = (await c.issues.duplicate.mutate({
        id: a.id as string,
        canonicalId: a.canonicalId as string,
      })) as unknown
      return { text: `${a.id} marked duplicate of ${a.canonicalId}`, data: i }
    },
  },
  {
    name: 'dep-remove',
    summary: 'Remove a dependency: dep-remove <fromId> <toId> [--type].',
    args: z.object({ fromId: idArg, toId: idArg, type: z.string().optional() }),
    positionals: ['fromId', 'toId'],
    async run(c, a) {
      const i = (await c.issues.depRemove.mutate({
        fromId: a.fromId as string,
        toId: a.toId as string,
        ...(a.type ? { type: a.type as string } : {}),
      })) as unknown
      return { text: `dep removed ${a.fromId} -> ${a.toId}`, data: i }
    },
  },
  {
    name: 'reparent',
    summary: "Set/clear an issue's parent: reparent <id> [--parentId <id>] (omit parentId to clear).",
    args: z.object({ id: idArg, parentId: idArg.optional() }),
    positionals: ['id', 'parentId'],
    async run(c, a) {
      const i = (await c.issues.reparent.mutate({
        id: a.id as string,
        parentId: (a.parentId as string) ?? null,
      })) as unknown
      return {
        text: a.parentId ? `${a.id} parented to ${a.parentId}` : `${a.id} unparented`,
        data: i,
      }
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
      return {
        text: ds.length
          ? ds.map((d) => `${d.a} ~ ${d.b} (${d.score.toFixed(2)})`).join('\n')
          : '(no duplicates)',
        data: ds,
      }
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
      return { text: `${g.nodes.length} nodes, ${g.edges.length} edges`, data: g }
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
      return {
        text: `cycles: ${d.cycles.length}, dangling: ${d.danglingDeps.length}, lint: ${d.lintCount}, stale: ${d.staleCount}`,
        data: d,
      }
    },
  },
  {
    name: 'preflight',
    summary: 'Pre-PR check (ok if no cycles/dangling deps).',
    args: z.object(optRepo),
    async run(c, a) {
      const p = (await c.issues.preflight.query(a as { repoPath?: string })) as { ok: boolean }
      return { text: p.ok ? 'preflight: OK' : 'preflight: FAIL (run doctor)', data: p }
    },
  },
  {
    name: 'stale',
    summary: 'Issues with no activity in N days (--days 30).',
    args: z.object({ ...optRepo, days: z.coerce.number().optional() }),
    async run(c, a) {
      const rows = (await c.issues.stale.query(a as never)) as Row[]
      return listResult(rows, '(none stale)')
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
      return {
        text: rows.length
          ? rows.map((r) => `#${r.seq} ${r.title} (${r.ref})`).join('\n')
          : '(no orphans)',
        data: rows,
      }
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
      return {
        text: rows.length
          ? rows.map((r) => `#${r.seq}: ${r.findings.join('; ')}`).join('\n')
          : '(lint clean)',
        data: rows,
      }
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
      return {
        text: `by stage: ${JSON.stringify(ct.byStage)}\nby type: ${JSON.stringify(ct.byType)}`,
        data: ct,
      }
    },
  },
  {
    name: 'prime',
    summary: "Print this session's issue context (bound issue + children/blockers, or ready-work lobby).",
    args: z.object(optRepo),
    async run(c, a) {
      const text = (await c.issues.prime.query(a as { repoPath?: string })) as string
      return { text, data: { prime: text } }
    },
  },
  {
    name: 'events',
    summary: 'Event log since a cursor: events --since <id> [--kind a,b] [--limit n].',
    args: z.object({
      since: z.coerce.number().int().min(0).default(0),
      kind: z.string().optional(),
      repoPath: z.string().optional(),
      limit: z.coerce.number().int().optional(),
    }),
    async run(c, a) {
      const kinds = a.kind
        ? String(a.kind)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
      const rows = (await c.issues.events.query({
        since: a.since as number,
        ...(kinds?.length ? { kinds } : {}),
        ...(a.repoPath ? { repoPath: a.repoPath as string } : {}),
        ...(a.limit != null ? { limit: a.limit as number } : {}),
      })) as { id: number; ts: string; kind: string; subject: string; payload: unknown }[]
      return {
        text: rows.length
          ? rows
              .map((e) => `[${e.id}] ${e.ts} ${e.kind} ${e.subject} ${JSON.stringify(e.payload)}`)
              .join('\n')
          : '(no events)',
        data: rows,
      }
    },
  },
  {
    name: 'state',
    summary:
      'One-paragraph "where things stand" the USER reads in the issue sidebar — update whenever the situation changes: state <id> [--set "…"]. No flags = print.',
    args: z.object({ id: idArg, set: z.string().optional() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (a.set != null
        ? await c.issues.panelApply.mutate({
            id: a.id as string,
            op: 'state-set',
            text: a.set,
          } as never)
        : await c.issues.get.query({ id: a.id as string })) as {
        seq: number
        panel?: { state?: { text: string; updatedAt: string } }
      } | null
      if (!i) throw new Error(`unknown issue ${a.id}`)
      const s = i.panel?.state
      return {
        text: s ? `${s.text}\n(updated ${s.updatedAt})` : '(no state posted)',
        data: s ?? null,
      }
    },
  },
  {
    name: 'todo',
    summary:
      'Human-facing todo list shown to the USER in the issue sidebar (keep it updated so they know what is left): todo <id> [--add "…"] [--done n] [--undone n] [--remove n] [--clear]. No flags = print it.',
    args: z.object({
      id: idArg,
      add: z.string().optional(),
      done: z.coerce.number().int().min(1).optional(),
      undone: z.coerce.number().int().min(1).optional(),
      remove: z.coerce.number().int().min(1).optional(),
      clear: z.boolean().optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const op =
        a.add != null
          ? { op: 'todo-add', text: a.add }
          : a.done != null
            ? { op: 'todo-done', index: a.done }
            : a.undone != null
              ? { op: 'todo-undone', index: a.undone }
              : a.remove != null
                ? { op: 'todo-remove', index: a.remove }
                : a.clear === true
                  ? { op: 'todo-clear' }
                  : null
      const i = (op
        ? await c.issues.panelApply.mutate({ id: a.id as string, ...op } as never)
        : await c.issues.get.query({ id: a.id as string })) as {
        seq: number
        panel?: { todos: { text: string; done: boolean }[] }
      } | null
      if (!i) throw new Error(`unknown issue ${a.id}`)
      const todos = i.panel?.todos ?? []
      const text = todos.length
        ? todos.map((t, n) => `${n + 1}. [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')
        : '(no human todos)'
      return { text, data: todos }
    },
  },
  {
    name: 'artifact',
    summary:
      'Artifacts the USER should look at (images/videos/html/md — UX shots, concept docs), shown in the issue sidebar: artifact <id> [--add <path>] [--title "…"] [--remove n]. Paths relative to the issue worktree or absolute. No flags = print.',
    args: z.object({
      id: idArg,
      add: z.string().optional(),
      title: z.string().optional(),
      remove: z.coerce.number().int().min(1).optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const op =
        a.add != null
          ? { op: 'artifact-add', path: a.add, ...(a.title ? { title: a.title as string } : {}) }
          : a.remove != null
            ? { op: 'artifact-remove', index: a.remove }
            : null
      const i = (op
        ? await c.issues.panelApply.mutate({ id: a.id as string, ...op } as never)
        : await c.issues.get.query({ id: a.id as string })) as {
        seq: number
        panel?: { artifacts: { path: string; title?: string; addedAt: string }[] }
      } | null
      if (!i) throw new Error(`unknown issue ${a.id}`)
      const arts = i.panel?.artifacts ?? []
      const text = arts.length
        ? arts.map((x, n) => `${n + 1}. ${x.title ? `${x.title} — ` : ''}${x.path}`).join('\n')
        : '(no artifacts)'
      return { text, data: arts }
    },
  },
  {
    name: 'deferred',
    summary:
      'Deferred-work list for the USER to decide on (shown in the issue sidebar): deferred <id> [--add "…"] [--remove n]. No flags = print.',
    args: z.object({
      id: idArg,
      add: z.string().optional(),
      remove: z.coerce.number().int().min(1).optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const op =
        a.add != null
          ? { op: 'deferred-add', text: a.add }
          : a.remove != null
            ? { op: 'deferred-remove', index: a.remove }
            : null
      const i = (op
        ? await c.issues.panelApply.mutate({ id: a.id as string, ...op } as never)
        : await c.issues.get.query({ id: a.id as string })) as {
        seq: number
        panel?: { deferred: { text: string; addedAt: string }[] }
      } | null
      if (!i) throw new Error(`unknown issue ${a.id}`)
      const items = i.panel?.deferred ?? []
      const text = items.length
        ? items.map((x, n) => `${n + 1}. ${x.text}`).join('\n')
        : '(no deferred work)'
      return { text, data: items }
    },
  },
  {
    name: 'children',
    summary:
      'List subissues of an issue/epic with ready/blocked status: children <id> [--recursive].',
    args: z.object({ id: idArg, recursive: z.boolean().optional() }),
    positionals: ['id'],
    async run(c, a) {
      const rows = (await c.issues.children.query({
        id: a.id as string,
        ...(a.recursive === true ? { recursive: true } : {}),
      })) as (Row & { ready: boolean; blocked: boolean; closedReason?: string })[]
      const mark = (r: (typeof rows)[number]) =>
        r.stage === 'done' || r.closedReason
          ? 'DONE'
          : r.blocked
            ? 'BLOCKED'
            : r.ready
              ? 'READY'
              : r.stage ?? ''
      return {
        text: rows.length
          ? rows.map((r) => `${line(r)} — ${mark(r)}`).join('\n')
          : '(no subissues)',
        data: rows,
      }
    },
  },
  {
    name: 'deps',
    summary:
      "Dependency status within a set of issues: deps [<id>] — an issue/epic's subtree (root included), or the whole repo without an id. Shows per issue what it waits on (open/closed) and what waits on it.",
    args: z.object({ id: idArg.optional(), ...optRepo }),
    positionals: ['id'],
    async run(c, a) {
      const entries = (await c.issues.depReport.query({
        ...(a.id ? { id: a.id as string } : {}),
        ...(a.repoPath ? { repoPath: a.repoPath as string } : {}),
      })) as {
        seq: number
        title: string
        stage: string
        priority: number
        closed: boolean
        blocked: boolean
        ready: boolean
        deps: { seq: number; title: string; type: string; closed: boolean }[]
        dependents: { seq: number; title: string; type: string; closed: boolean }[]
      }[]
      const edge = (r: { seq: number; type: string; closed: boolean }) =>
        `#${r.seq} (${r.closed ? 'closed' : 'open'}${r.type === 'blocks' ? '' : `, ${r.type}`})`
      const text = entries
        .map((e) => {
          const status = e.closed ? 'DONE' : e.blocked ? 'BLOCKED' : e.ready ? 'READY' : e.stage
          const lines = [`${line(e)} — ${status}`]
          if (e.deps.length) lines.push(`  waits on: ${e.deps.map(edge).join(', ')}`)
          if (e.dependents.length) lines.push(`  blocks: ${e.dependents.map(edge).join(', ')}`)
          return lines.join('\n')
        })
        .join('\n')
      return { text: text || '(no issues in set)', data: entries }
    },
  },
  {
    name: 'epic-status',
    summary: 'Epic completion: epic-status <id>.',
    args: z.object({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const e = (await c.issues.epicStatus.query({ id: a.id as string })) as {
        childCount: number
        childDoneCount: number
        complete: boolean
      }
      return {
        text: `${e.childDoneCount}/${e.childCount} done${e.complete ? ' (complete)' : ''}`,
        data: e,
      }
    },
  },
]
