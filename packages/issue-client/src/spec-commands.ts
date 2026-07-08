import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { IssueTrpc } from './client.js'

/** Wire shape of one pspec component's metadata (apps/server/src/pspec.ts —
 *  duplicated structurally here: packages never import apps). */
export interface SpecComponentMeta {
  id: string
  title: string
  /** Parent component id; empty for the root. */
  parent: string
  /** Sort position among siblings. */
  order: number
  status: 'active' | 'superseded' | 'draft'
  updatedAt: number
}

/**
 * `podium spec` — the agent interface to the living project spec (pspec v1,
 * see ./pspec.ts). Mirrors the issue-commands registry pattern: each command
 * is data ({name, summary, args, run}), shared by the CLI dispatcher (apps/cli).
 *
 * The spec records ONLY explicit human decisions and human-provided context.
 * The full duty-of-care rules agents must follow live in SPEC_AGENT_GUIDE,
 * emitted by `podium spec prime` (and committed as docs/agents/podium-specs.md).
 */

export interface SpecCommandResult {
  text: string
  data?: unknown
}

export interface SpecCommand {
  name: string
  summary: string
  args: z.ZodType
  /** Positional argv words mapped to these arg keys in order (flags still win). */
  positionals?: string[]
  /** Variadic tail: positionals beyond `positionals` join (space-separated) into this key. */
  restKey?: string
  run(client: IssueTrpc, args: Record<string, unknown>): Promise<SpecCommandResult>
}

/** How agents must treat the spec. Duplicated as docs/agents/podium-specs.md for humans. */
export const SPEC_AGENT_GUIDE = `THE PROJECT SPEC (pspec)
<repo>/pspec/ is the living spec: one HTML file per component, forming a tree
rooted at the project itself (SP-root). Every component has a stable id
(SP-xxxx). Code references the component it implements with a [spec:SP-xxxx]
comment; components interlink with <a href="#spec:SP-xxxx">. Bodies are
self-contained HTML (inline SVG/diagrams welcome).

READ before you build:
- Run \`podium spec tree\` / \`podium spec search <text>\` before non-trivial work
  and comply with decisions that touch your task. A [spec:SP-xxxx] comment in
  code you are changing means: \`podium spec show SP-xxxx\` first.

WRITE what humans decide — and nothing else:
- When the human states a decision or gives context in conversation, record it:
  rewrite it as concisely as possible (keep meaning, drop filler), place it in
  the right component, or create a narrowly-scoped sub-component
  (\`podium spec create <parent> "<title>"\`).
- Only explicit human decisions and human-provided context belong in the spec.
  Never record the obvious or common industry practice (assume it silently) —
  EXCEPT when the human's input contradicts best practice: confirm they mean
  it, then record the deviation with its why.
- Measure new input against the existing spec first. On contradiction, do not
  silently overwrite: flag it to the human, and once resolved mark the losing
  decision superseded (\`--status superseded\`) rather than deleting it.
- Ask a clarifying question when input is ambiguous or leaves a gap that
  matters now. Otherwise don't pester the human.
- When you implement a component, put [spec:SP-xxxx] in a code comment at the
  implementing site, and keep the spec's interlinks current.`

const repoArg = { repoPath: z.string() }
const STATUS = z.enum(['active', 'superseded', 'draft'])

function statusTag(s: SpecComponentMeta['status']): string {
  return s === 'active' ? '' : ` [${s}]`
}

/** Indented DFS rendering of the component tree from the flat meta list. */
function renderTree(components: SpecComponentMeta[]): string {
  const byParent = new Map<string, SpecComponentMeta[]>()
  for (const c of components) {
    if (!c.parent) continue
    const list = byParent.get(c.parent) ?? []
    list.push(c)
    byParent.set(c.parent, list)
  }
  const out: string[] = []
  const walk = (c: SpecComponentMeta, depth: number): void => {
    out.push(`${'  '.repeat(depth)}${c.id}  ${c.title}${statusTag(c.status)}`)
    for (const child of byParent.get(c.id) ?? []) walk(child, depth + 1)
  }
  const root = components.find((c) => c.id === 'SP-root')
  if (root) walk(root, 0)
  // Orphans (parent missing on disk) still surface rather than vanish.
  for (const c of components) {
    if (c.id !== 'SP-root' && !components.some((p) => p.id === c.parent)) walk(c, 0)
  }
  return out.length ? out.join('\n') : '(no spec yet)'
}

async function fetchList(client: IssueTrpc, repoPath: string): Promise<SpecComponentMeta[]> {
  return (await client.specs.list.query({ repoPath })) as SpecComponentMeta[]
}

export const SPEC_COMMANDS: SpecCommand[] = [
  {
    name: 'prime',
    summary: 'how to work with the spec + the current component tree',
    args: z.object({ ...repoArg }),
    run: async (client, a) => {
      const tree = renderTree(await fetchList(client, a.repoPath as string))
      const text = `${SPEC_AGENT_GUIDE}\n\nCURRENT SPEC TREE\n${tree}`
      return { text, data: { tree } }
    },
  },
  {
    name: 'tree',
    summary: 'the component tree (ids, titles, status)',
    args: z.object({ ...repoArg }),
    run: async (client, a) => {
      const list = await fetchList(client, a.repoPath as string)
      return { text: renderTree(list), data: list }
    },
  },
  {
    name: 'show',
    summary: 'one component: breadcrumb, children, and body HTML',
    args: z.object({ ...repoArg, id: z.string() }),
    positionals: ['id'],
    run: async (client, a) => {
      const repoPath = a.repoPath as string
      const spec = (await client.specs.get.query({ repoPath, id: a.id as string })) as
        | (SpecComponentMeta & { body: string })
        | null
      if (!spec) return { text: `no such component: ${a.id}`, data: null }
      const all = await fetchList(client, repoPath)
      const byId = new Map(all.map((c) => [c.id, c]))
      const crumbs: string[] = []
      for (let p = spec.parent; p; p = byId.get(p)?.parent ?? '') {
        crumbs.unshift(byId.get(p)?.title ?? p)
      }
      const children = all.filter((c) => c.parent === spec.id)
      const head = [
        `${spec.id}  ${spec.title}${statusTag(spec.status)}`,
        crumbs.length ? `under: ${crumbs.join(' > ')}` : null,
        children.length
          ? `children: ${children.map((c) => `${c.id} (${c.title})`).join(', ')}`
          : null,
        `code ref: [spec:${spec.id}]`,
      ]
        .filter(Boolean)
        .join('\n')
      return { text: `${head}\n\n${spec.body}`, data: spec }
    },
  },
  {
    name: 'search',
    summary: 'find components by title/body text',
    args: z.object({ ...repoArg, query: z.string() }),
    restKey: 'query',
    run: async (client, a) => {
      const hits = (await client.specs.search.query({
        repoPath: a.repoPath as string,
        query: a.query as string,
      })) as { id: string; title: string; snippet: string }[]
      return {
        text: hits.length
          ? hits.map((h) => `${h.id}  ${h.title} — ${h.snippet}`).join('\n')
          : 'no matches',
        data: hits,
      }
    },
  },
  {
    name: 'create',
    summary: 'add a component: create <parent-id> "<title>" [--body <html>]',
    args: z.object({
      ...repoArg,
      parent: z.string(),
      title: z.string(),
      body: z.string().optional(),
    }),
    positionals: ['parent', 'title'],
    run: async (client, a) => {
      const repoPath = a.repoPath as string
      const created = (await client.specs.create.mutate({
        repoPath,
        parent: a.parent as string,
        title: a.title as string,
      })) as SpecComponentMeta
      if (a.body != null) {
        await client.specs.save.mutate({ repoPath, id: created.id, body: a.body as string })
      }
      return {
        text: `created ${created.id} "${created.title}" under ${created.parent} — reference it in code as [spec:${created.id}]`,
        data: created,
      }
    },
  },
  {
    name: 'update',
    summary:
      'edit a component: update <id> [--title …] [--status active|draft|superseded] [--parent <id>] [--body <html> | --body-file <path>]',
    args: z.object({
      ...repoArg,
      id: z.string(),
      title: z.string().optional(),
      status: STATUS.optional(),
      parent: z.string().optional(),
      order: z.coerce.number().optional(),
      body: z.string().optional(),
      bodyFile: z.string().optional(),
    }),
    positionals: ['id'],
    run: async (client, a) => {
      const { repoPath, id, bodyFile, ...rest } = a as Record<string, unknown> & {
        repoPath: string
        id: string
        bodyFile?: string
      }
      // --body-file reads in THIS process (the agent's machine) — lets agents
      // author bodies in a scratch file instead of shell-quoting HTML.
      const body =
        bodyFile != null ? readFileSync(bodyFile, 'utf8') : (rest.body as string | undefined)
      const saved = (await client.specs.save.mutate({
        repoPath,
        id,
        ...(rest.title != null ? { title: rest.title as string } : {}),
        ...(rest.status != null
          ? { status: rest.status as 'active' | 'superseded' | 'draft' }
          : {}),
        ...(rest.parent != null ? { parent: rest.parent as string } : {}),
        ...(rest.order != null ? { order: rest.order as number } : {}),
        ...(body != null ? { body } : {}),
      })) as SpecComponentMeta
      return { text: `updated ${saved.id} "${saved.title}"${statusTag(saved.status)}`, data: saved }
    },
  },
  {
    name: 'import',
    summary:
      'bootstrap/refresh the spec from past sessions via an import agent (rerunnable; lands on a spec-import/<date> branch for review). --mode llm skips the agent (no codebase verification); --mode prepare only distills sessions + extracts candidate facts',
    args: z.object({ ...repoArg, mode: z.enum(['agent', 'llm', 'prepare']).optional() }),
    run: async (client, a) => {
      const repoPath = a.repoPath as string
      const specs = client.specs as unknown as {
        importStart: {
          mutate(i: { repoPath: string; mode?: string }): Promise<{ phase: string }>
        }
        importStatus: {
          query(i: { repoPath: string }): Promise<{
            phase: string
            message?: string
            error?: string
            branch?: string
            processed?: number
            total?: number
          }>
        }
      }
      await specs.importStart.mutate({
        repoPath,
        ...(a.mode != null ? { mode: a.mode as string } : {}),
      })
      // Poll until the run settles; the server does the heavy lifting.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const s = await specs.importStatus.query({ repoPath })
        if (s.phase === 'done') {
          return { text: s.message ?? 'import complete', data: s }
        }
        if (s.phase === 'error') return { text: `import failed: ${s.error}`, data: s }
        if (s.phase === 'idle') return { text: 'import did not start', data: s }
        process.stderr.write(
          `import: ${s.phase}${s.total ? ` (${s.processed ?? 0}/${s.total} sessions)` : ''}\n`,
        )
      }
    },
  },
  {
    name: 'remove',
    summary: 'delete a leaf component (children must be moved or deleted first)',
    args: z.object({ ...repoArg, id: z.string() }),
    positionals: ['id'],
    run: async (client, a) => {
      await client.specs.remove.mutate({
        repoPath: a.repoPath as string,
        id: a.id as string,
      })
      return { text: `removed ${a.id}` }
    },
  },
]
