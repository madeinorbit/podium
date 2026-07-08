import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseSpecFile, PSPEC_DIR, type SpecComponent } from './pspec'

/**
 * pspec × git — read spec components out of git refs and diff a branch's spec
 * against the canonical checkout (#172).
 *
 * The main Specs view edits the repo root's working tree; branches are
 * overlays. These helpers answer two questions without touching any worktree:
 * which branches carry pending pspec changes, and what exactly does one branch
 * change, component by component (both HTML sides, so the client can render a
 * rich diff instead of a text patch).
 */

const exec = promisify(execFile)
const MAX_BUFFER = 32 * 1024 * 1024

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoPath, ...args], { maxBuffer: MAX_BUFFER })
  return stdout
}

async function gitOrNull(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await git(repoPath, args)
  } catch {
    return null
  }
}

export type SpecChangeKind = 'added' | 'modified' | 'removed' | 'moved'

export interface SpecBranchChange {
  id: string
  title: string
  changeKind: SpecChangeKind
  /** Ancestor ids root→parent (from the branch side; base side for removals). */
  parentChain: { id: string; title: string }[]
  baseHtml: string | null
  headHtml: string | null
  /** Component meta from the side that still exists (head, else base). */
  status: SpecComponent['status']
  order: number
  parent: string
}

export interface SpecBranchSummary {
  branch: string
  /** Number of pspec component files touched vs the base. */
  changedComponents: number
  /** merge-base the diff is computed against. */
  baseRef: string
}

/** The ref the repo root's working tree is on — the "canon" side of every diff. */
async function canonRef(repoPath: string): Promise<string> {
  const head = (await gitOrNull(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim()
  return head || 'HEAD'
}

const SPEC_FILE_RE = /^pspec\/(SP-[a-z0-9]{4,12})\.html$/

async function changedSpecIds(
  repoPath: string,
  base: string,
  branch: string,
): Promise<Map<string, 'A' | 'M' | 'D'>> {
  const out = new Map<string, 'A' | 'M' | 'D'>()
  const diff = await gitOrNull(repoPath, [
    'diff',
    '--name-status',
    `${base}..${branch}`,
    '--',
    PSPEC_DIR,
  ])
  for (const line of (diff ?? '').split('\n')) {
    const [st, file] = line.split('\t')
    const id = file?.match(SPEC_FILE_RE)?.[1]
    if (!id || !st) continue
    const kind = st[0]
    if (kind === 'A' || kind === 'M' || kind === 'D') out.set(id, kind)
  }
  return out
}

/** Read every spec component present at `ref` (empty map when none). */
export async function specTreeAtRef(
  repoPath: string,
  ref: string,
): Promise<Map<string, SpecComponent>> {
  const out = new Map<string, SpecComponent>()
  const ls = await gitOrNull(repoPath, ['ls-tree', '--name-only', ref, `${PSPEC_DIR}/`])
  for (const file of (ls ?? '').split('\n')) {
    const id = file.match(SPEC_FILE_RE)?.[1]
    if (!id) continue
    const content = await gitOrNull(repoPath, ['show', `${ref}:${file}`])
    if (content === null) continue
    const parsed = parseSpecFile(content, id)
    if (parsed) out.set(parsed.id, parsed)
  }
  return out
}

function chainOf(
  c: SpecComponent,
  tree: Map<string, SpecComponent>,
): { id: string; title: string }[] {
  const chain: { id: string; title: string }[] = []
  const seen = new Set<string>([c.id])
  for (let p = c.parent; p && !seen.has(p); ) {
    seen.add(p)
    const node = tree.get(p)
    chain.unshift({ id: p, title: node?.title ?? p })
    p = node?.parent ?? ''
  }
  return chain
}

/**
 * Local branches whose pspec/ differs from their merge-base with the canon
 * branch. The canon branch itself is excluded.
 */
export async function specBranches(repoPath: string): Promise<SpecBranchSummary[]> {
  const canon = await canonRef(repoPath)
  const refs = await gitOrNull(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ])
  if (refs === null) return []
  const out: SpecBranchSummary[] = []
  for (const branch of refs.split('\n').map((b) => b.trim()).filter(Boolean)) {
    if (branch === canon) continue
    const base = (await gitOrNull(repoPath, ['merge-base', canon, branch]))?.trim()
    if (!base) continue
    const changed = await changedSpecIds(repoPath, base, branch)
    if (changed.size === 0) continue
    out.push({ branch, changedComponents: changed.size, baseRef: base })
  }
  return out
}

/** Per-component diff of `branch`'s pspec against its merge-base with canon. */
export async function specBranchDiff(
  repoPath: string,
  branch: string,
): Promise<{ baseRef: string; changes: SpecBranchChange[] }> {
  const canon = await canonRef(repoPath)
  const base = (await gitOrNull(repoPath, ['merge-base', canon, branch]))?.trim()
  if (!base) return { baseRef: '', changes: [] }
  const changed = await changedSpecIds(repoPath, base, branch)
  if (changed.size === 0) return { baseRef: base, changes: [] }
  const [baseTree, headTree] = await Promise.all([
    specTreeAtRef(repoPath, base),
    specTreeAtRef(repoPath, branch),
  ])
  const changes: SpecBranchChange[] = []
  for (const [id, st] of changed) {
    const baseC = baseTree.get(id) ?? null
    const headC = headTree.get(id) ?? null
    const live = headC ?? baseC
    if (!live) continue
    const changeKind: SpecChangeKind =
      st === 'A' || (!baseC && headC)
        ? 'added'
        : st === 'D' || (baseC && !headC)
          ? 'removed'
          : baseC && headC && baseC.parent !== headC.parent
            ? 'moved'
            : 'modified'
    changes.push({
      id,
      title: live.title,
      changeKind,
      parentChain: chainOf(live, headC ? headTree : baseTree),
      baseHtml: baseC?.body ?? null,
      headHtml: headC?.body ?? null,
      status: live.status,
      order: live.order,
      parent: live.parent,
    })
  }
  changes.sort((a, b) => a.parentChain.length - b.parentChain.length || a.order - b.order)
  return { baseRef: base, changes }
}
