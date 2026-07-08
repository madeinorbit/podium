import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { ROOT_SPEC_ID, serializeSpec, type SpecComponent } from './pspec'

/**
 * Spec-import engine (#172) — the LLM-facing half of `podium spec import`.
 *
 * Map: batches of session digests → candidate spec facts (JSON).
 * Reduce: current tree + facts → a small op list (create/update components).
 * Apply: ops over an in-memory copy of the canon tree.
 * Commit: the resulting tree lands on an import branch via git PLUMBING
 * (hash-object/mktree/commit-tree) — the user's working tree is never touched;
 * review happens through the specs branch-diff view.
 */

const exec = promisify(execFile)

export interface SpecFact {
  featureArea: string
  kind: 'decision' | 'constraint' | 'behavior'
  statement: string
  why?: string
  quote?: string
  conversationId?: string
  date?: string
}

export type SpecImportOp =
  | { op: 'create'; ref: string; parent: string; title: string; bodyHtml: string }
  | {
      op: 'update'
      id: string
      bodyHtml?: string
      appendHtml?: string
      title?: string
      status?: SpecComponent['status']
    }

export const MAP_SYSTEM_PROMPT = `You extract product/engineering decisions from compressed agent-session digests.
Only extract things the HUMAN explicitly decided, required, or constrained — never standard best practice, never things the agent decided alone, never implementation narration.
Reply with ONLY a JSON array of facts:
[{"featureArea": "short feature name", "kind": "decision"|"constraint"|"behavior", "statement": "one sentence, present tense", "why": "the human's stated reason, if any", "quote": "short verbatim user quote", "conversationId": "...", "date": "YYYY-MM-DD"}]
Return [] if a digest contains nothing decision-like.`

export function mapUserPrompt(digests: string[]): string {
  return `Session digests follow. Extract the facts.\n\n${digests.join('\n\n---\n\n')}`
}

export const REDUCE_SYSTEM_PROMPT = `You maintain a living product spec: a tree of components (features), each holding the humans' explicit decisions and constraints.
Given the CURRENT spec tree and a list of extracted facts, produce operations that merge the facts in:
- Group facts by feature; create one component per feature (op "create", parent = an existing component id or the ref of another created component; use "${ROOT_SPEC_ID}" for top-level features). Nest sub-features under their feature.
- Component bodies are simple HTML (<p>, <ul>, <li>, <strong>). Each decision is one short bullet: the decision, then "— why: …" when a reason exists, then "(session <conversationId>, <date>)".
- When facts conflict, the NEWER date wins; record the older decision at the end under "<p><strong>Superseded</strong></p>" with its date.
- Prefer updating an existing component (op "update" with "appendHtml") over creating near-duplicates.
- Never invent decisions not present in the facts. Never restate obvious best practice.
Reply with ONLY JSON: {"ops": [{"op":"create","ref":"n1","parent":"SP-root","title":"...","bodyHtml":"..."}, {"op":"update","id":"SP-xxxx","appendHtml":"..."}]}`

export function reduceUserPrompt(
  tree: SpecComponent[],
  facts: SpecFact[],
): string {
  const outline = tree.map((c) => ({
    id: c.id,
    parent: c.parent,
    title: c.title,
    status: c.status,
    body: c.body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600),
  }))
  return `CURRENT SPEC TREE:\n${JSON.stringify(outline, null, 1)}\n\nFACTS:\n${JSON.stringify(facts, null, 1)}`
}

/** Parse the model's JSON reply (tolerates code fences and prose padding). */
export function parseJsonReply<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? text).trim()
  const start = Math.min(
    ...['[', '{'].map((ch) => {
      const i = raw.indexOf(ch)
      return i < 0 ? Number.POSITIVE_INFINITY : i
    }),
  )
  if (!Number.isFinite(start)) return null
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'))
  if (end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

function allocateId(existing: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = `SP-${randomBytes(3).toString('hex').slice(0, 4)}`
    if (!existing.has(id)) {
      existing.add(id)
      return id
    }
  }
  throw new Error('could not allocate a spec id')
}

/**
 * Apply reduce ops to a copy of the tree. Invalid ops (unknown parent/id,
 * cycles by construction impossible: creates only attach to known nodes) are
 * skipped and reported rather than failing the whole import.
 */
export function applyImportOps(
  tree: Map<string, SpecComponent>,
  ops: SpecImportOp[],
  now: number,
): { components: Map<string, SpecComponent>; applied: number; skipped: string[] } {
  const out = new Map<string, SpecComponent>()
  for (const [id, c] of tree) out.set(id, { ...c })
  const ids = new Set(out.keys())
  const refToId = new Map<string, string>()
  const skipped: string[] = []
  let applied = 0
  for (const op of ops) {
    if (op.op === 'create') {
      const parent = out.has(op.parent) ? op.parent : refToId.get(op.parent)
      if (!parent) {
        skipped.push(`create "${op.title}": unknown parent ${op.parent}`)
        continue
      }
      const siblings = [...out.values()].filter((c) => c.parent === parent)
      const id = allocateId(ids)
      refToId.set(op.ref, id)
      out.set(id, {
        id,
        title: op.title.trim() || 'Untitled',
        parent,
        order: siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 1,
        status: 'draft',
        updatedAt: now,
        body: op.bodyHtml || '<p></p>',
      })
      applied++
    } else {
      const c = out.get(op.id)
      if (!c) {
        skipped.push(`update ${op.id}: unknown component`)
        continue
      }
      if (op.bodyHtml !== undefined) c.body = op.bodyHtml
      if (op.appendHtml) c.body = `${c.body}\n${op.appendHtml}`
      if (op.title) c.title = op.title
      if (op.status) c.status = op.status
      c.updatedAt = now
      applied++
    }
  }
  return { components: out, applied, skipped }
}

/**
 * Commit `components` as the full pspec/ tree on `branch`, parented on the
 * current commit of `baseRef` — pure plumbing, no working tree involved.
 */
export async function commitSpecTree(
  repoPath: string,
  branch: string,
  baseRef: string,
  components: Map<string, SpecComponent>,
  message: string,
): Promise<string> {
  const git = async (args: string[], stdin?: string): Promise<string> => {
    const child = exec('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 })
    if (stdin !== undefined && child.child.stdin) {
      child.child.stdin.write(stdin)
      child.child.stdin.end()
    }
    return (await child).stdout.trim()
  }
  const baseCommit = await git(['rev-parse', baseRef])
  const entries: string[] = []
  for (const c of [...components.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const blob = await git(['hash-object', '-w', '--stdin'], serializeSpec(c))
    entries.push(`100644 blob ${blob}\t${c.id}.html`)
  }
  const pspecTree = await git(['mktree'], `${entries.join('\n')}\n`)
  const rootLines = (await git(['ls-tree', baseCommit]))
    .split('\n')
    .filter((l) => l && !l.endsWith('\tpspec'))
  rootLines.push(`040000 tree ${pspecTree}\tpspec`)
  const rootTree = await git(['mktree'], `${rootLines.join('\n')}\n`)
  const commit = await git(['commit-tree', rootTree, '-p', baseCommit, '-m', message])
  await git(['update-ref', `refs/heads/${branch}`, commit])
  return commit
}
