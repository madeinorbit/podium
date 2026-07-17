import { IssueColor, TITLE_RULE_TERSE } from '@podium/protocol'
import { z } from 'zod'
import type { IssueTrpc } from './client.js'

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
  /** Variadic tail: positionals beyond `positionals` join (comma-separated) into this
   *  arg key, so `show 1 2 3` ≡ `show 1 --ids 2,3`. An explicit flag wins. */
  restKey?: string
  run(client: IssueTrpc, args: Record<string, unknown>): Promise<IssueCommandResult>
}

const repoArg = { repoPath: z.string() }
const optRepo = { repoPath: z.string().optional() }

/** Issue references accept the internal `iss_…` id or the display seq the CLI prints
 *  (`10` / `#10`); MCP callers may pass the seq as a number. Resolution happens
 *  server-side (IssueService.resolveRef). */
const idArg = z.union([z.string(), z.number()]).transform((v) => String(v))

/** Boolean flag that also accepts an explicit value: `--pinned`, `--pinned true`,
 *  `--pinned=false` (a bare flag parses to `true`; values arrive as strings). */
const cliBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

// One-line summary of an issue for list/ready/blocked output.
function line(i: { seq: number; title: string; priority?: number; stage?: string }): string {
  const p = i.priority != null ? `P${i.priority} ` : ''
  const s = i.stage ? `[${i.stage}] ` : ''
  return `#${i.seq} ${p}${s}${i.title}`
}

/** Render a send disposition as a human note (#834): the sender learns whether a
 *  message landed on a live agent, is holding for the issue's next session, or
 *  waking one — never a bare "sent" that hides a hold. `delivered`/`queued` need
 *  no note (the default reading of "sent"). */
function mailDispositionNote(disposition?: string): string {
  switch (disposition) {
    case 'held':
      return ' — HELD for the issue’s next session (no live session right now)'
    case 'spawning':
      return ' — waking a session to receive it'
    default:
      return ''
  }
}

type Row = Parameters<typeof line>[0]
const listResult = (rows: Row[], empty: string): IssueCommandResult => ({
  text: rows.length ? rows.map(line).join('\n') : empty,
  data: rows,
})

/** The slice of an issue wire the show renderer reads. */
interface ShowWire {
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
  machineId?: string | null
  color?: string | null
}

/** One comment as the show renderer prints it (issues.comments payload, #175). */
interface ShowComment {
  author: string
  body: string
  createdAt: string
}

/** Fetch an issue's comment thread via the lazy issues.comments proc (#175 —
 *  bodies no longer ride IssueWire). Best-effort: a server without the proc
 *  (pre-#175) or a fetch error just renders the issue without its thread. */
async function fetchComments(c: IssueTrpc, id: string): Promise<ShowComment[]> {
  try {
    return (await c.issues.comments.query({ id })) as ShowComment[]
  } catch {
    return []
  }
}

/** The single-issue `show` rendering — shared verbatim by single and bulk show.
 *  `comments` is fetched separately (#175); empty ⇒ no comments section. */
function renderShow(i: ShowWire, comments: ShowComment[] = []): string {
  const meta = [
    `stage=${i.stage} P${i.priority} ready=${i.ready} blocked=${i.blocked}`,
    i.assignee ? `assignee=${i.assignee}` : null,
    i.defaultAgent || i.defaultModel || i.defaultEffort
      ? `agent=${i.defaultAgent ?? 'auto'} model=${i.defaultModel ?? 'auto'} effort=${i.defaultEffort ?? 'auto'}`
      : null,
    i.machineId ? `machine=${i.machineId}` : null,
    i.color ? `color=${i.color}` : null,
    i.labels?.length ? `labels=${i.labels.join(',')}` : null,
    i.branch ? `branch=${i.branch}` : null,
    i.needsHuman ? `NEEDS HUMAN${i.humanQuestion ? `: ${i.humanQuestion}` : ''}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  const thread = comments.length
    ? `\n\ncomments (${comments.length}):\n${comments
        .map((cm) => `- ${cm.author} (${cm.createdAt}): ${cm.body}`)
        .join('\n')}`
    : ''
  return `#${i.seq} ${i.title}\n${meta}\n\n${i.description}${thread}`
}

/** One node of the issues.tree payload (issue #82) as the CLI renders it. */
interface TreeNode {
  seq: number
  title: string
  stage: string
  priority: number
  assignee?: string
  branch?: string
  needsHuman: boolean
  humanQuestion?: string
  blocksDeps: number[]
  description: string
  closed: boolean
  blocked: boolean
  ready: boolean
  children: TreeNode[]
  omittedChildren: number
}

export const ISSUE_COMMANDS: IssueCommand[] = [
  {
    name: 'ready',
    summary: 'List issues ready to work (open, not deferred, unblocked).',
    args: z.strictObject(optRepo),
    async run(c, a) {
      const rows = (await c.issues.ready.query(a as { repoPath?: string })) as Row[]
      return listResult(rows, '(no ready issues)')
    },
  },
  {
    name: 'blocked',
    summary: 'List issues blocked by an open dependency.',
    args: z.strictObject(optRepo),
    async run(c, a) {
      const rows = (await c.issues.blocked.query(a as { repoPath?: string })) as Row[]
      return listResult(rows, '(no blocked issues)')
    },
  },
  {
    name: 'list',
    summary: 'List all issues in the repo.',
    args: z.strictObject(optRepo),
    async run(c, a) {
      const rows = (await c.issues.list.query(a as { repoPath?: string })) as Row[]
      return listResult(rows, '(no issues)')
    },
  },
  {
    name: 'show',
    summary:
      'Show issues in full: show <id> [<id>...] or show --ids a,b,c. One call surveys many issues (each rendered like single show).',
    args: z.strictObject({ id: idArg.optional(), ids: z.string().optional() }),
    positionals: ['id'],
    restKey: 'ids',
    async run(c, a) {
      const refs = [
        ...(a.id != null ? [String(a.id)] : []),
        ...(a.ids
          ? String(a.ids)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : []),
      ]
      if (refs.length === 0) throw new Error('show needs at least one issue id')
      // Exactly one id keeps the historical contract: unknown issue THROWS
      // (non-zero exit) and data is the single issue object, not a 1-array.
      if (refs.length === 1) {
        const i = (await c.issues.get.query({ id: refs[0]! })) as ShowWire | null
        if (!i) throw new Error(`unknown issue ${refs[0]}`)
        // #175: the thread comes from the lazy comments proc (the wire only
        // carries commentCount); data keeps embedding it for --json consumers.
        const comments = await fetchComments(c, i.id)
        return { text: renderShow(i, comments), data: { ...i, comments } }
      }
      // Bulk: per-id failures (unknown/ambiguous ref) become an inline error
      // entry instead of failing the whole call — a 24-child survey should not
      // die on one stale ref. data = array (issue wires ⊕ {ref,error} entries).
      const results = await Promise.all(
        refs.map(
          async (
            ref,
          ): Promise<(ShowWire & { comments: ShowComment[] }) | { ref: string; error: string }> => {
            try {
              const i = (await c.issues.get.query({ id: ref })) as ShowWire | null
              if (!i) return { ref, error: `unknown issue ${ref}` }
              return { ...i, comments: await fetchComments(c, i.id) }
            } catch (err) {
              return { ref, error: err instanceof Error ? err.message : String(err) }
            }
          },
        ),
      )
      const text = results
        .map((r) =>
          'error' in r && !('seq' in r)
            ? `${r.ref}: ERROR ${r.error}`
            : renderShow(r as ShowWire, (r as { comments?: ShowComment[] }).comments ?? []),
        )
        .join('\n\n')
      return { text, data: results }
    },
  },
  {
    name: 'tree',
    summary:
      'Whole epic in ONE call: tree <id> — the issue + all descendants (depth ≤3, ≤100 nodes) with stage/priority/assignee/branch/needs-human/blocking deps and a description snippet. Prefer this over per-child show when surveying an epic.',
    args: z.strictObject({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const t = (await c.issues.tree.query({ id: a.id as string })) as {
        root: TreeNode
        totalNodes: number
        omitted: number
      }
      const out: string[] = []
      const walk = (n: TreeNode, depth: number): void => {
        const pad = '  '.repeat(depth)
        const status = n.closed ? 'DONE' : n.blocked ? 'BLOCKED' : n.ready ? 'READY' : n.stage
        const extras = [
          n.assignee ? `assignee=${n.assignee}` : null,
          n.branch ? `branch=${n.branch}` : null,
          n.blocksDeps.length ? `waits-on=${n.blocksDeps.map((s) => `#${s}`).join(',')}` : null,
          n.needsHuman ? `NEEDS HUMAN${n.humanQuestion ? `: ${n.humanQuestion}` : ''}` : null,
        ].filter(Boolean)
        out.push(
          `${pad}#${n.seq} P${n.priority} [${n.stage}] ${n.title} — ${status}${extras.length ? ` (${extras.join(' ')})` : ''}`,
        )
        if (n.description) out.push(`${pad}    ${n.description}`)
        for (const ch of n.children) walk(ch, depth + 1)
        if (n.omittedChildren > 0) out.push(`${'  '.repeat(depth + 1)}(+${n.omittedChildren} more)`)
      }
      walk(t.root, 0)
      return { text: out.join('\n'), data: t }
    },
  },
  {
    name: 'create',
    summary: `Create an issue: create --title "…" (see --help for flags). --audience human puts it on the human board; agent-created issues default to internal (audience agent). ${TITLE_RULE_TERSE}`,
    args: z.strictObject({
      ...repoArg,
      title: z.string().min(1),
      description: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      type: z.string().optional(),
      parentId: idArg.optional(),
      audience: z.enum(['human', 'agent']).optional(),
      agent: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
      machine: z.string().min(1).optional(),
      assignee: z.string().optional(),
      labels: z.string().optional(),
      parentBranch: z.string().optional(),
      // Colour slot [spec:SP-b4d1]: rose|pink|fuchsia|violet|indigo|blue|cyan|teal|green|lime.
      color: IssueColor.optional(),
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
        ...(a.audience ? { audience: a.audience as 'human' | 'agent' } : {}),
        ...(a.agent ? { defaultAgent: a.agent as string } : {}),
        ...(a.model ? { defaultModel: a.model as string } : {}),
        ...(a.effort ? { defaultEffort: a.effort as string } : {}),
        ...(a.machine ? { machineId: a.machine as string } : {}),
        ...(a.assignee ? { assignee: a.assignee as string } : {}),
        ...(a.color ? { color: a.color as never } : {}),
        // --labels is comma-separated on the CLI; the proc takes an array.
        ...(a.labels
          ? {
              labels: (a.labels as string)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
        ...(a.parentBranch ? { parentBranch: a.parentBranch as string } : {}),
      })) as { seq: number; title: string; worktreePath?: string | null; warning?: string }
      const started = a.start === true && i.worktreePath ? ` (started in ${i.worktreePath})` : ''
      const warn = i.warning ? `\n⚠ ${i.warning}` : ''
      return { text: `created #${i.seq} ${i.title}${started}${warn}`, data: i }
    },
  },
  {
    name: 'start',
    summary:
      'Start an issue: create its worktree+branch, claim it, spawn its agent. start <id> [--agent claude-code] [--force-unknown-model]. Model/effort come from the issue (set via create/update --model/--effort).',
    args: z.strictObject({
      id: idArg,
      agent: z.string().min(1).optional(),
      'force-unknown-model': z.boolean().optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.start.mutate({
        id: a.id as string,
        ...(a.agent ? { agentKind: a.agent as string } : {}),
        ...(a['force-unknown-model'] ? { forceUnknownModel: true } : {}),
      })) as {
        seq: number
        worktreePath?: string | null
        branch?: string | null
        agentId?: string
        harness?: string
        model?: string | null
        effort?: string | null
        machine?: string
      }
      const placement = i.agentId
        ? `\n  ${i.agentId} (${i.harness ?? 'unknown'}) model=${i.model ?? 'default'} effort=${i.effort ?? 'default'} machine=${i.machine ?? 'unknown'}`
        : ''
      return {
        text: `started #${i.seq} (${i.branch ?? '?'} @ ${i.worktreePath ?? '?'})${placement}`,
        data: i,
      }
    },
  },
  {
    name: 'update',
    summary: `Update fields on an issue: update <id> --<field> <value> … (see --help for flags). Retitling: ${TITLE_RULE_TERSE}`,
    args: z.strictObject({
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
      machine: z.string().min(1).optional(),
      parentId: z.string().optional(),
      parentBranch: z.string().optional(),
      design: z.string().optional(),
      acceptance: z.string().optional(),
      notes: z.string().optional(),
      dueAt: z.string().optional(),
      deferUntil: z.string().optional(),
      closedReason: z.string().optional(),
      pinned: cliBool.optional(),
      // Colour slot [spec:SP-b4d1]; 'none' clears back to the neutral flow.
      color: z.union([IssueColor, z.literal('none')]).optional(),
      estimateMin: z.coerce.number().int().optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const patch: Record<string, unknown> = {}
      const passthrough = [
        'stage',
        'priority',
        'assignee',
        'title',
        'description',
        'type',
        'parentId',
        'parentBranch',
        'design',
        'acceptance',
        'notes',
        'dueAt',
        'deferUntil',
        'closedReason',
        'pinned',
        'estimateMin',
      ]
      for (const k of passthrough) if (a[k] != null) patch[k] = a[k]
      if (a.agent != null) patch.defaultAgent = a.agent
      if (a.model != null) patch.defaultModel = a.model
      if (a.effort != null) patch.defaultEffort = a.effort
      // 'none' clears the pin (back to repo-affinity routing).
      if (a.machine != null) patch.machineId = a.machine === 'none' ? null : a.machine
      // 'none' clears the colour (back to the neutral slate flow) [spec:SP-b4d1].
      if (a.color != null) patch.color = a.color === 'none' ? null : a.color
      // An empty patch is a caller mistake (typo'd/absent flags), not a success (#345).
      if (Object.keys(patch).length === 0) {
        throw new Error('update: no fields given — nothing changed (see update --help for flags)')
      }
      const i = (await c.issues.update.mutate({ id: a.id as string, patch: patch as never })) as {
        seq: number
      }
      return { text: `updated #${i.seq}`, data: i }
    },
  },
  {
    name: 'attach',
    summary: `Re-home THIS session onto an issue: attach --id <issue> (existing, may be outside your scope) or attach --subissue "<title>" --confirm-rehome (create a child of your current real issue and move there). A native subagent must not self-attach; its parent attaches it. Draft moves and self-attach no-ops need no confirmation. An abandoned empty draft is cleaned up. ${TITLE_RULE_TERSE}`,
    args: z.strictObject({
      id: idArg.optional(),
      subissue: z.string().min(1).optional(),
      confirmRehome: z.boolean().optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      if (!a.id && !a.subissue) throw new Error('attach needs --id <issue> or --subissue "<title>"')
      // sessionId is stamped server-side from the relay context (the daemon knows
      // which session is calling); it is never taken from agent-supplied input.
      const i = (await c.issues.attachSession.mutate({
        ...(a.id ? { targetId: a.id as string } : {}),
        ...(a.subissue ? { newSubissue: { title: a.subissue as string } } : {}),
        ...(a.confirmRehome ? { confirmRehome: true } : {}),
      } as never)) as { seq: number; title: string }
      return { text: `attached to #${i.seq} ${i.title}`, data: i }
    },
  },
  {
    name: 'close',
    summary:
      'Close an issue: close <id> [--reason done|superseded|duplicate|wontfix] [--note "handoff"].',
    args: z.strictObject({
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
    args: z.strictObject({ id: idArg, assignee: z.string() }),
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
    summary:
      'Archive an issue: archive <id>. Agents may archive inside their subtree; use --outside-scope elsewhere.',
    args: z.strictObject({ id: idArg }),
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
    args: z.strictObject({ id: idArg, kind: z.enum(['rebase', 'pr', 'merge', 'integrate']) }),
    positionals: ['id', 'kind'],
    async run(c, a) {
      // integrate is its own local-only proc (like cleanup): it must never be
      // hub-forwarded, while the other kinds go through the forwarding action proc.
      const r = (
        a.kind === 'integrate'
          ? await c.issues.integrate.mutate({ id: a.id as string })
          : await c.issues.action.mutate({
              id: a.id as string,
              kind: a.kind as 'rebase' | 'pr' | 'merge',
            })
      ) as { ok: boolean; output: string }
      return { text: `${a.kind}: ${r.ok ? 'OK' : 'FAILED'}\n${r.output}`.trim(), data: r }
    },
  },
  {
    name: 'cleanup',
    summary:
      "Remove a closed issue's worktree and delete its merged branch: cleanup <id>. Guarded: refuses unless the issue is closed, the branch is fully merged into its parent, and the worktree is clean (never --force / -D).",
    args: z.strictObject({ id: idArg }),
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
    summary:
      "Spawn another agent session in a started issue's worktree: add-session <id> [--agent claude-code] [--force-unknown-model]. Model/effort follow the issue defaults (update --model/--effort).",
    args: z.strictObject({
      id: idArg,
      agent: z.string().optional(),
      'force-unknown-model': z.boolean().optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.addSession.mutate({
        id: a.id as string,
        ...(a.agent ? { agentKind: a.agent as string } : {}),
        ...(a['force-unknown-model'] ? { forceUnknownModel: true } : {}),
      })) as { seq: number }
      return { text: `session added to #${i.seq}`, data: i }
    },
  },
  {
    name: 'add-shell',
    summary: "Spawn a shell in a started issue's worktree: add-shell <id>.",
    args: z.strictObject({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.addShell.mutate({ id: a.id as string })) as { seq: number }
      return { text: `shell added to #${i.seq}`, data: i }
    },
  },
  {
    name: 'dep-add',
    summary:
      'Add a dependency, <from> depends on <to>: dep-add <fromId> <toId> [--type blocks|related|discovered-from|…].',
    args: z.strictObject({ fromId: idArg, toId: idArg, type: z.string().optional() }),
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
    args: z.strictObject({
      id: idArg,
      author: z.string().default('agent'),
      body: z.string().min(1),
    }),
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
    // One dispatcher command (the registry is a flat single-word table; the sub-verb
    // rides in as the first positional): mail send <id> --body "…" · mail inbox [<id>]
    // · mail claim <msgId> · mail pending [<id>].
    name: 'mail',
    summary:
      'Agent mail addressed to an issue: mail send <id> --body "…" · mail inbox [<id>] · mail claim <msgId> · mail pending [<id>].',
    args: z.strictObject({
      sub: z.enum(['send', 'inbox', 'claim', 'pending']),
      ref: idArg.optional(),
      body: z.string().optional(),
    }),
    positionals: ['sub', 'ref'],
    async run(c, a) {
      const ref = a.ref as string | undefined
      switch (a.sub as string) {
        case 'send': {
          if (!ref) throw new Error('mail send needs an issue id: mail send <id> --body "…"')
          if (!a.body) throw new Error('mail send needs --body')
          const m = (await c.issues.mailSend.mutate({ id: ref, body: a.body as string })) as {
            id: string
            issueId: string
            ok?: boolean
            disposition?: string
            reason?: string
          }
          // Tell the sender what ACTUALLY happened (#834): held / dead_letter are
          // never a silent "sent". A dead-letter throws so the exit code is nonzero.
          if (m.ok === false || m.disposition === 'dead_letter') {
            throw new Error(m.reason ?? `mail to ${ref} could not be delivered`)
          }
          const note = mailDispositionNote(m.disposition)
          return { text: `mail sent to ${ref} (${m.id})${note}`, data: m }
        }
        case 'inbox': {
          const msgs = (await c.issues.mailInbox.mutate(ref ? { id: ref } : {})) as {
            id: string
            fromAuthor: string
            body: string
            createdAt: string
            status: string
            wasUnread: boolean
          }[]
          return {
            text: msgs.length
              ? msgs
                  .map(
                    (m) =>
                      `${m.wasUnread ? '*' : ' '} ${m.id} ${m.fromAuthor} ${m.createdAt}${m.status === 'claimed' ? ' [claimed]' : ''}\n  ${m.body}`,
                  )
                  .join('\n')
              : '(no mail)',
            data: msgs,
          }
        }
        case 'claim': {
          if (!ref) throw new Error('mail claim needs a message id: mail claim <msgId>')
          const r = (await c.issues.mailClaim.mutate({ messageId: ref })) as {
            claimed: boolean
            message: { id: string; claimedBy: string | null }
          }
          return {
            text: r.claimed
              ? `claimed ${ref}`
              : `already claimed${r.message.claimedBy ? ` by ${r.message.claimedBy}` : ''}: ${ref}`,
            data: r,
          }
        }
        case 'pending': {
          const p = (await c.issues.mailPending.query(ref ? { id: ref } : {})) as {
            unread: number
          }
          return { text: `${p.unread} unread`, data: p }
        }
        default:
          throw new Error(`unknown mail subcommand: ${a.sub}`)
      }
    },
  },
  {
    // Event subscriptions (Phase B): THIS agent asks to be told when an event fires.
    // subscription add <event> --source-kind relationship|issue|session --source-ref <ref>
    //   [--nudge] [--notify] · subscription list · subscription remove <id>.
    name: 'subscription',
    summary:
      'Subscribe THIS agent to events: subscription add <event> --source-kind relationship|issue|session --source-ref <ref> [--nudge] [--notify] · subscription list · subscription remove <id>. Events: issue.closed, issue.stage_changed:review, session.finished/errored/waiting. Relationship refs: my-children, my-subtree.',
    args: z.strictObject({
      sub: z.enum(['add', 'remove', 'list']),
      ref: z.string().optional(),
      sourceKind: z.enum(['relationship', 'issue', 'session']).optional(),
      sourceRef: z.string().optional(),
      nudge: z.boolean().optional(),
      notify: z.boolean().optional(),
    }),
    positionals: ['sub', 'ref'],
    async run(c, a) {
      switch (a.sub as string) {
        case 'add': {
          if (!a.ref)
            throw new Error(
              'subscription add needs an event: subscription add <event> --source-kind … --source-ref …',
            )
          if (!a.sourceKind || !a.sourceRef)
            throw new Error('subscription add needs --source-kind and --source-ref')
          const deliver =
            a.nudge != null || a.notify != null
              ? {
                  ...(a.nudge != null ? { nudge: a.nudge as boolean } : {}),
                  ...(a.notify != null ? { notify: a.notify as boolean } : {}),
                }
              : undefined
          const s = (await c.issues.subscriptionAdd.mutate({
            event: a.ref as string,
            source: { kind: a.sourceKind as never, ref: a.sourceRef as string },
            ...(deliver ? { deliver } : {}),
          })) as { id: string; event: string; sourceKind: string; sourceRef: string }
          return {
            text: `subscribed ${s.id}: ${s.event} <- ${s.sourceKind}:${s.sourceRef}`,
            data: s,
          }
        }
        case 'remove': {
          if (!a.ref) throw new Error('subscription remove needs an id: subscription remove <id>')
          const r = (await c.issues.subscriptionRemove.mutate({ id: a.ref as string })) as {
            removed: boolean
          }
          return {
            text: r.removed ? `removed ${a.ref}` : `no such subscription: ${a.ref}`,
            data: r,
          }
        }
        case 'list': {
          const rows = (await c.issues.subscriptionList.query()) as {
            id: string
            event: string
            sourceKind: string
            sourceRef: string
            enabled: boolean
            deliverNudge: boolean
            deliverNotify: boolean
          }[]
          const fmt = (s: (typeof rows)[number]) => {
            const deliver =
              [s.deliverNudge && 'nudge', s.deliverNotify && 'notify'].filter(Boolean).join(',') ||
              'none'
            return `${s.id} ${s.event} <- ${s.sourceKind}:${s.sourceRef}${s.enabled ? '' : ' (disabled)'} [${deliver}]`
          }
          return {
            text: rows.length ? rows.map(fmt).join('\n') : '(no subscriptions)',
            data: rows,
          }
        }
        default:
          throw new Error(`unknown subscription subcommand: ${a.sub}`)
      }
    },
  },
  {
    name: 'search',
    summary: 'Search issues (--text --status --priority --type --label …).',
    args: z.strictObject({
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
    args: z.strictObject(optRepo),
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
    summary: 'Soft-delete an issue and tombstone its sessions (maintainer): delete <id>.',
    args: z.strictObject({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const r = (await c.issues.delete.mutate({ id: a.id as string })) as unknown
      return { text: `deleted ${a.id}`, data: r }
    },
  },
  {
    name: 'restore',
    summary: 'Restore an issue and its sessions as exited records: restore <id>.',
    args: z.strictObject({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const r = (await c.issues.restore.mutate({ id: a.id as string })) as unknown
      return { text: `restored ${a.id}`, data: r }
    },
  },
  {
    name: 'label',
    summary: "Set an issue's labels (replaces): label <id> --labels a,b,c.",
    args: z.strictObject({ id: idArg, labels: z.string() }),
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
    args: z.strictObject({ id: idArg, until: z.string() }),
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
    summary: "End an issue's snooze: undefer <id> (floats it back to the top of WORK).",
    args: z.strictObject({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.undefer.mutate({ id: a.id as string })) as unknown
      return { text: `undeferred ${a.id}`, data: i }
    },
  },
  {
    name: 'needs-human',
    summary:
      'Flag an issue as needing a human decision: needs-human <id> [--question "…"] ' +
      '[--options "Yes|No|Later"] [--asked-by <sessionId>]. Options are |-separated ' +
      'suggested answers the web tray renders as chips. asked-by defaults to your own ' +
      'session and is server-authoritative: agents may not attribute to another session ' +
      '(operator-only).',
    args: z.strictObject({
      id: idArg,
      question: z.string().optional(),
      options: z.string().optional(),
      'asked-by': z.string().optional(),
    }),
    positionals: ['id'],
    async run(c, a) {
      const options = a.options
        ? String(a.options)
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean)
        : []
      const i = (await c.issues.setNeedsHuman.mutate({
        id: a.id as string,
        ...(a.question ? { question: a.question as string } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(a['asked-by'] ? { askedBy: a['asked-by'] as string } : {}),
      })) as unknown
      return { text: `flagged ${a.id} for human`, data: i }
    },
  },
  {
    name: 'answer-question',
    summary:
      "Answer an issue's pending needs-human question and clear the flag: " +
      'answer-question <id> <answer>. Delivered to the asking session (menu digits ' +
      'when a native menu is up, chat message otherwise); fails without clearing ' +
      'when it cannot be delivered.',
    args: z.strictObject({ id: idArg, answer: z.string() }),
    positionals: ['id', 'answer'],
    async run(c, a) {
      const r = (await c.issues.answerQuestion.mutate({
        id: a.id as string,
        answer: a.answer as string,
      })) as { deliveredVia?: string }
      return { text: `answered ${a.id} (via ${r.deliveredVia ?? 'unknown'})`, data: r }
    },
  },
  {
    name: 'clear-needs-human',
    summary: 'Clear the needs-human flag: clear-needs-human <id>.',
    args: z.strictObject({ id: idArg }),
    positionals: ['id'],
    async run(c, a) {
      const i = (await c.issues.clearNeedsHuman.mutate({ id: a.id as string })) as unknown
      return { text: `cleared needs-human on ${a.id}`, data: i }
    },
  },
  {
    name: 'supersede',
    summary:
      'Supersede <old> with <new>: supersede <oldId> <newId>. Agents: in-subtree, or confirm with --outside-scope.',
    args: z.strictObject({ oldId: idArg, newId: idArg }),
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
    summary:
      'Mark a duplicate: duplicate <id> <canonicalId>. Agents: in-subtree, or confirm with --outside-scope.',
    args: z.strictObject({ id: idArg, canonicalId: idArg }),
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
    summary:
      'Remove a dependency: dep-remove <fromId> <toId> [--type]. Agents: in-subtree, or confirm with --outside-scope.',
    args: z.strictObject({ fromId: idArg, toId: idArg, type: z.string().optional() }),
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
    summary:
      "Set/clear an issue's parent: reparent <id> [--parentId <id>] (omit parentId to clear). Agents: in-subtree, or confirm with --outside-scope.",
    args: z.strictObject({ id: idArg, parentId: idArg.optional() }),
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
    args: z.strictObject({ ...optRepo, threshold: z.coerce.number().optional() }),
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
    args: z.strictObject(optRepo),
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
    args: z.strictObject(optRepo),
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
    args: z.strictObject(optRepo),
    async run(c, a) {
      const p = (await c.issues.preflight.query(a as { repoPath?: string })) as { ok: boolean }
      return { text: p.ok ? 'preflight: OK' : 'preflight: FAIL (run doctor)', data: p }
    },
  },
  {
    name: 'stale',
    summary: 'Issues with no activity in N days (--days 30).',
    args: z.strictObject({ ...optRepo, days: z.coerce.number().optional() }),
    async run(c, a) {
      const rows = (await c.issues.stale.query(a as never)) as Row[]
      return listResult(rows, '(none stale)')
    },
  },
  {
    name: 'orphans',
    summary: 'Open issues referenced in commits (implemented-but-open).',
    args: z.strictObject(repoArg),
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
    args: z.strictObject(optRepo),
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
    args: z.strictObject(optRepo),
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
    summary:
      "Print this session's issue context (bound issue + children/blockers, or ready-work lobby).",
    args: z.strictObject(optRepo),
    async run(c, a) {
      const text = (await c.issues.prime.query(a as { repoPath?: string })) as string
      return { text, data: { prime: text } }
    },
  },
  {
    name: 'events',
    summary: 'Event log since a cursor: events --since <id> [--kind a,b] [--limit n].',
    args: z.strictObject({
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
    args: z.strictObject({ id: idArg, set: z.string().optional() }),
    positionals: ['id'],
    async run(c, a) {
      const i = (
        a.set != null
          ? await c.issues.setState.mutate({ id: a.id as string, text: a.set as string })
          : await c.issues.get.query({ id: a.id as string })
      ) as {
        seq: number
        activityNotes?: string
        notesUpdatedAt?: string
      } | null
      if (!i) throw new Error(`unknown issue ${a.id}`)
      return {
        text: i.activityNotes
          ? `${i.activityNotes}${i.notesUpdatedAt ? `\n(updated ${i.notesUpdatedAt})` : ''}`
          : '(no state posted)',
        data: i.activityNotes
          ? { text: i.activityNotes, updatedAt: i.notesUpdatedAt ?? null }
          : null,
      }
    },
  },
  {
    name: 'todo',
    summary:
      'Human-facing todo list shown to the USER in the issue sidebar (keep it updated so they know what is left): todo <id> [--add "…"] [--done n] [--undone n] [--remove n] [--clear]. No flags = print it.',
    args: z.strictObject({
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
      const i = (
        op
          ? await c.issues.panelApply.mutate({ id: a.id as string, ...op } as never)
          : await c.issues.get.query({ id: a.id as string })
      ) as {
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
    args: z.strictObject({
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
      const i = (
        op
          ? await c.issues.panelApply.mutate({ id: a.id as string, ...op } as never)
          : await c.issues.get.query({ id: a.id as string })
      ) as {
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
    args: z.strictObject({
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
      const i = (
        op
          ? await c.issues.panelApply.mutate({ id: a.id as string, ...op } as never)
          : await c.issues.get.query({ id: a.id as string })
      ) as {
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
    args: z.strictObject({ id: idArg, recursive: z.boolean().optional() }),
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
              : (r.stage ?? '')
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
    args: z.strictObject({ id: idArg.optional(), ...optRepo }),
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
    args: z.strictObject({ id: idArg }),
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
