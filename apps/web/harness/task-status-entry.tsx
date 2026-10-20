/** Real chat, compact-reference and terminal decoration renderers over the same fixtures.
 * Serve with vite.harness.config.ts and open /harness/task-status.html?theme=light. */
import { issueReferenceModel } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { referenceView } from '@podium/client-graph/issue-reference'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { createTerminalReferences } from '@podium/client-graph/terminal-references'
import { ALL_ISSUE_STATUSES, ISSUE_STATUS_LABELS, isIssueStage } from '@podium/model'
import { createRoot } from 'react-dom/client'
import { IssueReference } from '@/components/IssueReference'
import { bindIssueRefAnchors } from '@/lib/issue-chip-liveness'
import { renderMarkdown } from '@/lib/markdown'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import { makeIssue } from '@/lib/test-issue'
import { RefUnderlineOverlay } from '../../../packages/terminal-client/src/ref-underline-overlay'
import '@/index.css'
import '@/styles.css'

const light = new URLSearchParams(location.search).get('theme') === 'light'
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', !light)
setKnownRefPrefixes(['POD'])

const fixtures = ALL_ISSUE_STATUSES.map((status, index) => ({
  label: ISSUE_STATUS_LABELS[status],
  issue: makeIssue({
    id: `iss_status_${index}`,
    seq: 101 + index,
    title: 'Task reference',
    prefix: 'POD',
    displayRef: `POD-${101 + index}`,
    stage: isIssueStage(status) ? status : 'done',
    closedReason: isIssueStage(status) ? undefined : status,
  }),
}))
fixtures.push(
  {
    label: 'Archived cancelled',
    issue: makeIssue({
      id: 'iss_archived',
      seq: 111,
      prefix: 'POD',
      displayRef: 'POD-111',
      title: 'Archived task',
      stage: 'done',
      closedReason: 'cancelled',
      archived: true,
    }),
  },
  {
    label: 'Legacy wontfix',
    issue: makeIssue({
      id: 'iss_legacy',
      seq: 112,
      prefix: 'POD',
      displayRef: 'POD-112',
      title: 'Legacy task',
      stage: 'done',
      closedReason: 'wontfix',
    }),
  },
  {
    label: 'Unrecognized close reason',
    issue: makeIssue({
      id: 'iss_unknown',
      seq: 113,
      prefix: 'POD',
      displayRef: 'POD-113',
      title: 'Older task',
      stage: 'done',
      closedReason: 'obsolete',
    }),
  },
  {
    label: 'Deleted',
    issue: makeIssue({
      id: 'iss_deleted',
      seq: 114,
      prefix: 'POD',
      displayRef: 'POD-114',
      title: 'Deleted task',
      stage: 'done',
      deletedAt: '2026-01-01T00:00:00Z',
    }),
  },
)
const pool = new MobxPool(
  { selectedIssueId: null, coarseNow: Date.parse('2026-10-20') },
  undefined,
  {
    summaries: SHELL_SUMMARIES,
    issueIdByRef: () => undefined,
  },
)
pool.apply({
  type: 'replace',
  rows: [
    {
      kind: 'worktree',
      id: '/r',
      value: {
        path: '/r',
        repoId: 'status-repo',
        prefix: 'POD',
        repoPath: '/r',
        repoName: 'Status fixtures',
      } as never,
    },
    ...fixtures.map(({ issue }) => ({
      kind: 'issue' as const,
      id: issue.id,
      value: { ...issue, repoId: 'status-repo' } as never,
    })),
  ],
})
const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
root.className = 'desktop-shell'
root.style.cssText = 'max-width:1000px;margin:0 auto;padding:36px;font-size:14px'
root.innerHTML =
  '<h1 style="font-size:22px;font-weight:600;margin-bottom:8px">Task reference statuses</h1><p class="text-muted-foreground" style="margin-bottom:24px">All ten statuses, plus archive, legacy and unavailable cases. Hover a chat badge for its full status.</p><table style="width:100%;border-collapse:collapse;text-align:left"><thead><tr class="text-muted-foreground"><th>Status</th><th>Chat badge</th><th>Compact reference</th><th>Terminal</th></tr></thead><tbody></tbody></table>'
const body = root.querySelector('tbody')
if (!body) throw new Error('Missing status table')
const cleanups: Array<() => void> = []
for (const { label, issue } of fixtures) {
  const model = issueReferenceModel(issue)
  const row = document.createElement('tr')
  row.style.cssText = 'height:42px;border-bottom:1px solid var(--border)'
  const name = row.insertCell()
  name.textContent = label
  const chat = row.insertCell()
  chat.className = 'chat-md'
  chat.innerHTML = renderMarkdown(model.ref)
  const compact = row.insertCell()
  const react = createRoot(compact)
  react.render(<IssueReference model={model} showTitle={false} />)
  cleanups.push(() => react.unmount())
  const terminal = row.insertCell()
  const screen = document.createElement('div')
  screen.style.cssText = 'position:relative;width:10ch;height:24px;font:13px/24px monospace'
  screen.textContent = model.ref
  terminal.appendChild(screen)
  body.appendChild(row)
  const references = createTerminalReferences(pool)
  const overlay = new RefUnderlineOverlay({
    screen,
    getCols: () => 10,
    getRows: () => 1,
    getIsKnownPrefix: () => () => true,
    getResolveStatus: () => (token) => references.resolveStatus(token),
    beginPaint: () => references.beginPaint(),
    endPaint: () => references.endPaint(),
    getBuffer: () => ({
      viewportY: 0,
      getLine: (y) =>
        y === 0
          ? {
              length: model.ref.length,
              isWrapped: false,
              translateToString: () => model.ref,
              getCell: (x) => ({
                getChars: () => model.ref[x] ?? ' ',
                getWidth: () => 1,
                isBold: () => false,
                isUnderline: () => false,
                getFgColor: () => -1,
                getFgColorMode: () => 0,
              }),
            }
          : undefined,
    }),
  })
  overlay.refreshNow()
  cleanups.push(() => {
    overlay.dispose()
    references.dispose()
  })
}
const missing = body.insertRow()
missing.style.height = '42px'
missing.insertCell().textContent = 'Unavailable'
const unknown = missing.insertCell()
unknown.className = 'chat-md'
unknown.innerHTML = renderMarkdown('POD-999')
missing.insertCell().textContent = 'Unknown status'
missing.insertCell().textContent = 'POD-999'
cleanups.push(
  bindIssueRefAnchors(root, {
    watch(ref, paint) {
      const view = createPoolProjection(pool, () => referenceView(pool).read(ref))
      const update = () => {
        const model = view.getSnapshot()
        paint(typeof model === 'symbol' ? 'loading' : (model ?? null))
      }
      update()
      const stop = view.subscribe(update)
      return () => {
        stop()
        view.dispose()
      }
    },
  }),
)
window.addEventListener(
  'pagehide',
  () => {
    for (const stop of cleanups) stop()
    pool.dispose()
  },
  { once: true },
)
