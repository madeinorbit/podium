import { ChevronRight } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { diffHtml } from './lib/htmldiff'

/**
 * Rendered spec branch-diff (#172) — shared by the Specs view's branch overlay
 * and the right dock's Specs tab. Not a text patch: each changed component is a
 * card with its tree breadcrumb and the merged HTML (word-level <ins>/<del>).
 */

export type SpecChangeKind = 'added' | 'modified' | 'removed' | 'moved'

export interface SpecBranchChangeWire {
  id: string
  title: string
  changeKind: SpecChangeKind
  parentChain: { id: string; title: string }[]
  baseHtml: string | null
  headHtml: string | null
  status: 'active' | 'superseded' | 'draft'
  order: number
  parent: string
}

const KIND_LABEL: Record<SpecChangeKind, string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  moved: 'MV',
}

const KIND_CLASS: Record<SpecChangeKind, string> = {
  added: 'bg-green-500/15 text-green-600 dark:text-green-400',
  modified: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  removed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  moved: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
}

export function ChangeBadge({ kind }: { kind: SpecChangeKind }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center rounded px-1 font-mono text-[10px] font-semibold',
        KIND_CLASS[kind],
      )}
      title={kind}
    >
      {KIND_LABEL[kind]}
    </span>
  )
}

/** Prose styling + ins/del marks for the merged diff HTML. */
const DIFF_PROSE = cn(
  'text-[13px] leading-relaxed [overflow-wrap:anywhere]',
  '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold',
  '[&_ins]:rounded-sm [&_ins]:bg-green-500/20 [&_ins]:no-underline [&_ins]:decoration-clone',
  '[&_del]:rounded-sm [&_del]:bg-red-500/15 [&_del]:text-muted-foreground',
)

/**
 * A navigable mini component tree: the changed nodes plus their ancestors,
 * badges on changed nodes. `onSelect` scrolls/navigates.
 */
export function SpecDiffMiniTree({
  changes,
  onSelect,
}: {
  changes: SpecBranchChangeWire[]
  onSelect: (id: string) => void
}): JSX.Element {
  interface Node {
    id: string
    title: string
    change?: SpecBranchChangeWire
    children: Node[]
  }
  const roots = useMemo(() => {
    const nodes = new Map<string, Node>()
    const ensure = (id: string, title: string): Node => {
      let n = nodes.get(id)
      if (!n) {
        n = { id, title, children: [] }
        nodes.set(id, n)
      }
      return n
    }
    const rootList: Node[] = []
    for (const c of changes) {
      let parent: Node | null = null
      for (const link of c.parentChain) {
        const node = ensure(link.id, link.title)
        if (parent && !parent.children.includes(node)) parent.children.push(node)
        if (!parent && !rootList.includes(node)) rootList.push(node)
        parent = node
      }
      const leaf = ensure(c.id, c.title)
      leaf.change = c
      if (parent && !parent.children.includes(leaf)) parent.children.push(leaf)
      if (!parent && !rootList.includes(leaf)) rootList.push(leaf)
    }
    return rootList
  }, [changes])

  const render = (node: Node, depth: number): JSX.Element => (
    <div key={node.id}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left text-[12px]',
          node.change
            ? 'text-foreground hover:bg-accent'
            : 'cursor-default text-muted-foreground/70',
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => node.change && onSelect(node.id)}
      >
        <span className="truncate">{node.title}</span>
        {node.change && <ChangeBadge kind={node.change.changeKind} />}
      </button>
      {node.children.map((c) => render(c, depth + 1))}
    </div>
  )

  return <div className="py-1">{roots.map((n) => render(n, 0))}</div>
}

/** Stacked per-component diff cards. Card DOM ids are `spec-diff-<id>` so a
 *  mini-tree/tree click can scrollIntoView. */
export function SpecDiffCards({ changes }: { changes: SpecBranchChangeWire[] }): JSX.Element {
  if (changes.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">No spec changes on this branch.</div>
    )
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {changes.map((c) => (
        <section
          key={c.id}
          id={`spec-diff-${c.id}`}
          className="scroll-mt-3 rounded-lg border border-border bg-card"
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <ChangeBadge kind={c.changeKind} />
            <span className="truncate text-[13px] font-medium">{c.title}</span>
            <span className="ml-auto flex min-w-0 items-center gap-0.5 text-[10px] text-muted-foreground">
              {c.parentChain.map((p) => (
                <span key={p.id} className="flex items-center gap-0.5 truncate">
                  {p.title}
                  <ChevronRight size={9} aria-hidden="true" />
                </span>
              ))}
              <span className="font-mono">{c.id}</span>
            </span>
          </header>
          <div
            className={cn('px-3 py-2', DIFF_PROSE)}
            // Spec bodies are first-party editor output; the diff only adds ins/del.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering stored spec HTML
            dangerouslySetInnerHTML={{ __html: diffHtml(c.baseHtml, c.headHtml) }}
          />
        </section>
      ))}
    </div>
  )
}
