import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * pspec v1 — a living, nested spec that humans and agents write together.
 *
 * Storage: one HTML file per spec component under `<repo>/pspec/`, named
 * `<id>.html`. Each file is a single `<section>` whose data attributes carry
 * the component's identity and tree position; the section body is free-form
 * self-contained HTML (the WYSIWYG editor's output). Components link to each
 * other with `<a href="#spec:SP-xxxx">` (a fragment, so any HTML tooling —
 * including the editor's sanitizer — accepts it), and code references components with
 * `[spec:SP-xxxx]` comments — the ID is the stable join key everywhere, so
 * components can move within the tree without breaking links.
 *
 * The root component (the project itself) always has id `SP-root`.
 */

export const PSPEC_DIR = 'pspec'
export const ROOT_SPEC_ID = 'SP-root'

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

export interface SpecComponent extends SpecComponentMeta {
  /** Inner HTML of the component's <section> — the editable body. */
  body: string
}

export interface SpecSearchHit {
  id: string
  title: string
  /** Plain-text snippet around the first match. */
  snippet: string
}

const ID_RE = /^SP-[a-z0-9]{4,12}$/
const FILE_RE = /^(SP-[a-z0-9]{4,12})\.html$/

export function isSpecId(id: string): boolean {
  return id === ROOT_SPEC_ID || ID_RE.test(id)
}

function specDir(repoPath: string): string {
  return join(repoPath, PSPEC_DIR)
}

function specFile(repoPath: string, id: string): string {
  // isSpecId guards every caller, so `id` can never contain path separators —
  // but assert anyway: this joins into the user's repo.
  if (!isSpecId(id) || basename(id) !== id) throw new Error(`invalid spec id: ${id}`)
  return join(specDir(repoPath), `${id}.html`)
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function unescapeAttr(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&')
}

function serialize(c: SpecComponent): string {
  const attrs = [
    `data-spec="${escapeAttr(c.id)}"`,
    `data-title="${escapeAttr(c.title)}"`,
    `data-parent="${escapeAttr(c.parent)}"`,
    `data-order="${c.order}"`,
    `data-status="${c.status}"`,
    `data-updated="${c.updatedAt}"`,
  ].join(' ')
  return `<!-- pspec v1 — edit via Podium Specs; id is stable, referenced from code as [spec:${c.id}] -->\n<section ${attrs}>\n${c.body.trim()}\n</section>\n`
}

function readAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`))
  return m ? unescapeAttr(m[1] ?? '') : undefined
}

/** Parse one component file. Returns null for files that don't match the format. */
export function parseSpecFile(content: string, fallbackId: string): SpecComponent | null {
  const open = content.match(/<section\b[^>]*>/)
  if (!open) return null
  const tag = open[0]
  const start = (open.index ?? 0) + tag.length
  const end = content.lastIndexOf('</section>')
  if (end < start) return null
  const id = readAttr(tag, 'data-spec') ?? fallbackId
  if (!isSpecId(id)) return null
  const statusRaw = readAttr(tag, 'data-status')
  return {
    id,
    title: readAttr(tag, 'data-title') ?? id,
    parent: readAttr(tag, 'data-parent') ?? (id === ROOT_SPEC_ID ? '' : ROOT_SPEC_ID),
    order: Number(readAttr(tag, 'data-order') ?? '0') || 0,
    status: statusRaw === 'superseded' || statusRaw === 'draft' ? statusRaw : 'active',
    updatedAt: Number(readAttr(tag, 'data-updated') ?? '0') || 0,
    body: content.slice(start, end).trim(),
  }
}

function readAll(repoPath: string): Map<string, SpecComponent> {
  const out = new Map<string, SpecComponent>()
  let entries: string[]
  try {
    entries = readdirSync(specDir(repoPath))
  } catch {
    return out
  }
  for (const name of entries) {
    const m = name.match(FILE_RE)
    if (!m) continue
    try {
      const parsed = parseSpecFile(readFileSync(join(specDir(repoPath), name), 'utf8'), m[1] ?? '')
      if (parsed) out.set(parsed.id, parsed)
    } catch {
      // unreadable file — skip; the rest of the spec stays usable
    }
  }
  return out
}

function writeComponent(repoPath: string, c: SpecComponent): void {
  mkdirSync(specDir(repoPath), { recursive: true })
  writeFileSync(specFile(repoPath, c.id), serialize(c), 'utf8')
}

/** Ensure the root "project" component exists; returns all components. */
function readAllWithRoot(repoPath: string): Map<string, SpecComponent> {
  const all = readAll(repoPath)
  if (!all.has(ROOT_SPEC_ID)) {
    const root: SpecComponent = {
      id: ROOT_SPEC_ID,
      title: basename(repoPath),
      parent: '',
      order: 0,
      status: 'active',
      updatedAt: Date.now(),
      body: '<p>Project spec. Decisions the humans have explicitly made live here — nothing obvious, nothing invented.</p>',
    }
    // Persist lazily only once someone actually writes; an empty repo browsing
    // Specs shouldn't create a pspec/ folder as a side effect.
    all.set(ROOT_SPEC_ID, root)
  }
  return all
}

export function listSpecs(repoPath: string): SpecComponentMeta[] {
  return [...readAllWithRoot(repoPath).values()]
    .map(({ body: _body, ...meta }) => meta)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

export function getSpec(repoPath: string, id: string): SpecComponent | null {
  return readAllWithRoot(repoPath).get(id) ?? null
}

function freshId(existing: Map<string, SpecComponent>): string {
  for (let i = 0; i < 100; i++) {
    const id = `SP-${randomBytes(3).toString('hex').slice(0, 4)}`
    if (!existing.has(id)) return id
  }
  throw new Error('could not allocate a spec id')
}

export function createSpec(
  repoPath: string,
  input: { title: string; parent: string },
): SpecComponent {
  const all = readAllWithRoot(repoPath)
  const parent = all.get(input.parent)
  if (!parent) throw new Error(`parent component not found: ${input.parent}`)
  const siblings = [...all.values()].filter((c) => c.parent === input.parent)
  const c: SpecComponent = {
    id: freshId(all),
    title: input.title.trim() || 'Untitled',
    parent: input.parent,
    order: siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 1,
    status: 'draft',
    updatedAt: Date.now(),
    body: '<p></p>',
  }
  // Materialize the root on first real write so links to SP-root resolve on disk.
  if (parent.id === ROOT_SPEC_ID) writeComponent(repoPath, parent)
  writeComponent(repoPath, c)
  return c
}

export function saveSpec(
  repoPath: string,
  input: {
    id: string
    body?: string
    title?: string
    parent?: string
    order?: number
    status?: SpecComponent['status']
  },
): SpecComponent {
  const all = readAllWithRoot(repoPath)
  const c = all.get(input.id)
  if (!c) throw new Error(`spec component not found: ${input.id}`)
  if (input.parent !== undefined && input.id !== ROOT_SPEC_ID) {
    if (!all.has(input.parent)) throw new Error(`parent component not found: ${input.parent}`)
    // Re-parenting must not create a cycle: walk up from the new parent.
    for (let p = input.parent; p; p = all.get(p)?.parent ?? '') {
      if (p === input.id) throw new Error('cannot move a component under its own subtree')
    }
    c.parent = input.parent
  }
  if (input.body !== undefined) c.body = input.body
  if (input.title !== undefined) c.title = input.title.trim() || c.title
  if (input.order !== undefined) c.order = input.order
  if (input.status !== undefined) c.status = input.status
  c.updatedAt = Date.now()
  writeComponent(repoPath, c)
  return c
}

export function removeSpec(repoPath: string, id: string): void {
  if (id === ROOT_SPEC_ID) throw new Error('cannot delete the project root component')
  const all = readAllWithRoot(repoPath)
  if (!all.has(id)) return
  const children = [...all.values()].filter((c) => c.parent === id)
  if (children.length > 0) {
    throw new Error(`component has ${children.length} sub-component(s); move or delete them first`)
  }
  try {
    unlinkSync(specFile(repoPath, id))
  } catch {
    // already gone
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function searchSpecs(repoPath: string, query: string): SpecSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SpecSearchHit[] = []
  for (const c of readAllWithRoot(repoPath).values()) {
    const text = stripTags(c.body)
    const inTitle = c.title.toLowerCase().includes(q)
    const at = text.toLowerCase().indexOf(q)
    if (!inTitle && at < 0) continue
    const snippet =
      at >= 0 ? text.slice(Math.max(0, at - 60), at + q.length + 60).trim() : text.slice(0, 120)
    hits.push({ id: c.id, title: c.title, snippet })
  }
  return hits.slice(0, 50)
}
