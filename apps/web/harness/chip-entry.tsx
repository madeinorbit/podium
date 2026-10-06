import { referenceView } from '@podium/client-graph/issue-reference'
/**
 * Issue chip styles over the real Markdown output and per-reference pool
 * subscriptions. The left column shows undecorated Markdown; the right shows
 * live pool values. React mount and mutation routing have focused unit coverage.
 */
import { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { IssueStage } from '@podium/model'
import { bindIssueRefAnchors } from '@/lib/issue-chip-liveness'
import { renderMarkdown } from '@/lib/markdown'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'

setKnownRefPrefixes(['POD'])

// Every token in `index.css` hangs off `[data-theme="podium"]`, which the app
// sets in `theme.tsx`. A harness page that only imports the stylesheet resolves
// every `var(--…)` to nothing and paints black on black — and a colour
// comparison across chips that are all `rgb(0,0,0)` passes for the wrong reason.
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.add('dark')

/** Synthetic payloads; displayed values are always projected by the pool. */
type Issue = ReturnType<typeof makeIssue>

const issue = (seq: number, stage: IssueStage, title: string, over: Partial<Issue> = {}): Issue =>
  makeIssue({
    id: `iss_${seq}`,
    seq,
    prefix: 'POD',
    displayRef: `POD-${seq}`,
    title,
    stage,
    ...over,
  })

/** Every stage the chip can wear, both non-present availabilities, and a ref no
 *  issue answers — which must STAY the grey question mark after the pass. */
const ISSUES: Issue[] = [
  issue(101, 'proposed', 'Off-palette chips in the worklist'),
  issue(102, 'backlog', 'Relation chip wording'),
  issue(103, 'planning', 'Pasted image thumbs go dead'),
  issue(104, 'in_progress', 'Chip liveness relanding'),
  issue(105, 'review', 'Stable dynamic issue chips'),
  issue(106, 'shipping', 'Machine chip meter tooltips'),
  issue(107, 'done', 'Backticked refs never linkify'),
  issue(108, 'in_progress', 'Archived but still working', { archived: true }),
  issue(109, 'review', 'Deleted mid-review', { deletedAt: '2026-08-24T00:00:00Z' }),
]

const rows = new Map(ISSUES.map((row) => [row.id, row]))
const ids = new Map(ISSUES.map((row) => [`POD-${row.seq}`, row.id]))
const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, {
  load: (_entity, id) => rows.get(id as Issue['id']),
  issueIdByRef: (ref) => ids.get(ref),
})
pool.apply({
  type: 'replace',
  rows: ISSUES.map((row) => ({ kind: 'issue', id: row.id, value: row as never })),
})

const PROSE = [
  'The composer minted a draft on `POD-104` and the deck has always covered for it.',
  '',
  'Stages, one per chip: POD-101, POD-102, POD-103, POD-104, POD-105, POD-106, POD-107.',
  '',
  'Availability is its own axis: POD-108 is archived, POD-109 is deleted, and',
  'POD-999999 is a ref this client has never heard of.',
  '',
  'A ref quoted inside a longer span stays literal: `podium issue show POD-105 --json`.',
].join('\n')

declare global {
  interface Window {
    chips: {
      /** Publish one stage update and report anchor/text identity. */
      restage: (seq: number, stage: IssueStage) => { sameAnchor: boolean; sameText: boolean }
    }
  }
}

function column(label: string, testid: string): HTMLDivElement {
  const section = document.createElement('section')
  section.className = 'min-w-0 flex-1'
  const heading = document.createElement('h2')
  heading.className = 'mb-2 font-mono text-muted-foreground text-xs uppercase tracking-wide'
  heading.textContent = label
  const body = document.createElement('div')
  body.dataset.testid = testid
  body.className = 'chat-md rounded-md border border-border p-4 text-sm leading-relaxed'
  body.innerHTML = renderMarkdown(PROSE)
  section.append(heading, body)
  document.querySelector('#root > .row')!.append(section)
  return body
}

const root = document.getElementById('root')!
root.className = 'desktop-shell'
root.innerHTML = '<div class="row flex gap-6 p-8"></div>'

column('Undecorated Markdown', 'before')
const after = column('Live pool references', 'after')
const stop = bindIssueRefAnchors(after, {
  watch(ref, paint) {
    const view = createPoolProjection(pool, () => referenceView(pool).read(ref))
    const update = () => {
      const model = view.getSnapshot()
      paint(typeof model === 'symbol' ? 'loading' : (model ?? null))
    }
    update()
    return view.subscribe(update)
  },
})
window.addEventListener(
  'pagehide',
  () => {
    stop()
    pool.dispose()
  },
  { once: true },
)

window.chips = {
  restage(seq, stage) {
    const selector = `a.ref-link--issue[data-ref="POD-${seq}"]`
    const anchorWas = after.querySelector<HTMLAnchorElement>(selector)
    const textWas = anchorWas?.firstChild
    // Without this, a selector that matches NOTHING reports sameAnchor: true —
    // `null === null` — and the identity check passes by finding no chip at all.
    if (!anchorWas || !textWas) throw new Error(`no chip to restage: ${selector}`)
    const target = rows.get(`iss_${seq}` as Issue['id'])
    if (!target) throw new Error(`no fixture issue POD-${seq}`)
    const changed = { ...target, stage }
    rows.set(target.id, changed)
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: target.id, value: changed as never }],
    })
    const anchorNow = after.querySelector<HTMLAnchorElement>(selector)
    return { sameAnchor: anchorNow === anchorWas, sameText: anchorNow?.firstChild === textWas }
  },
}
