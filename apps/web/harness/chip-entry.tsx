/**
 * ISSUE CHIPS, REAL, IN A BROWSER (POD-1624).
 *
 * The defect is visual and the fix is an attribute pass, so neither end can be
 * checked where there is no CSS: happy-dom will happily report
 * `data-issue-stage="review"` on an anchor that paints identically to an unknown
 * one. This renders the REAL markdown pipeline's output against the REAL
 * `styles.css` and runs the REAL `decorateIssueRefAnchors` over one of two
 * otherwise identical columns.
 *
 * The undecorated column is the control, and it is the whole point: it is what
 * main ships today, so the screenshot carries its own before/after. A rig that
 * only showed the fixed column could not tell "the pass works" from "these chips
 * were never grey to begin with".
 *
 * No React here on purpose. Both the pass and the markdown are plain DOM, and a
 * React host re-rendered `dangerouslySetInnerHTML` out from under the decorated
 * anchors — measuring the harness's own churn rather than the subject. The
 * component wrapper (`IssueChipLiveness`, its mount race and its
 * MutationObserver) is covered where it belongs, in its own vitest file.
 */
import type { IssueReferenceSource } from '@podium/client-core/viewmodels'
import { asIssueId, type IssueStage } from '@podium/model'
import { decorateIssueRefAnchors, issueReferenceLookup } from '@/lib/issue-chip-liveness'
import { renderMarkdown, setKnownRefPrefixes } from '@/lib/markdown'
import '@/index.css'
import '@/styles.css'

setKnownRefPrefixes(['POD'])

// Every token in `index.css` hangs off `[data-theme="podium"]`, which the app
// sets in `theme.tsx`. A harness page that only imports the stylesheet resolves
// every `var(--…)` to nothing and paints black on black — and a colour
// comparison across chips that are all `rgb(0,0,0)` passes for the wrong reason.
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.add('dark')

type Issue = IssueReferenceSource & {
  seq: number
  prefix: string
  displayRef: string
  title: string
}

const issue = (
  seq: number,
  stage: IssueStage,
  title: string,
  over: Partial<Issue> = {},
): Issue => ({
  id: asIssueId(`iss_${seq}`),
  seq,
  prefix: 'POD',
  displayRef: `POD-${seq}`,
  title,
  stage,
  archived: false,
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
      /** Move one issue to a new stage and re-run the pass, the way a fleet
       *  delta does. Reports whether the anchor and its text node survived. */
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

column('before — main today, no pass', 'before')
const after = column('after — liveness pass', 'after')
decorateIssueRefAnchors(after, issueReferenceLookup(ISSUES))

window.chips = {
  restage(seq, stage) {
    const selector = `a.ref-link--issue[data-ref="POD-${seq}"]`
    const anchorWas = after.querySelector<HTMLAnchorElement>(selector)
    const textWas = anchorWas?.firstChild
    const target = ISSUES.find((i) => i.seq === seq)
    if (target) target.stage = stage
    decorateIssueRefAnchors(after, issueReferenceLookup(ISSUES))
    const anchorNow = after.querySelector<HTMLAnchorElement>(selector)
    return { sameAnchor: anchorNow === anchorWas, sameText: anchorNow?.firstChild === textWas }
  },
}
