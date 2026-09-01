/**
 * THE COST SECTION, IN THE COLUMN IT SHIPS IN (POD-1859).
 *
 * jsdom proves the branches — no state collapses to a zero, `pending` draws no
 * motion, a childless task draws no split. It cannot show the thing a reviewer
 * has to judge: whether a 21px figure, a 7px split rail, two 11.5px kv rows and
 * a mono fold read as ONE section in a 340px dock, in the ink steps the rest of
 * that scroll is built from. Every one of those comes from `styles.css`.
 *
 * So the shipping `IssuePanelView` is mounted here four times against the real
 * stylesheet, once per state, with the explorer harness's stubbed store
 * answering `cost.task` from a fixture.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1859-cost-shots.ts <outDir>
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { ThemeProvider } from '@/app/theme'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import { IssuePanelView } from '@/features/issues/IssuePanelView'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'
import { state } from './explorer-store'

/** A model total on the wire — TOKENS, which the client prices. */
const tok = (
  model: string,
  o: Partial<{
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    messages: number
  }> = {},
) => ({
  model,
  inputTokens: o.inputTokens ?? 0,
  outputTokens: o.outputTokens ?? 0,
  cacheReadTokens: o.cacheReadTokens ?? 0,
  cacheCreationTokens: o.cacheCreationTokens ?? 0,
  cacheCreation1hTokens: 0,
  messages: o.messages ?? 0,
})

// POD-1574's real shape: own = rollup, no children, two Claude models. Token
// counts chosen to price at ≈$171.50 and ≈$54.30 through the one price table.
const OPUS = tok('claude-opus-5', {
  cacheReadTokens: 300_000_000,
  outputTokens: 800_000,
  inputTokens: 300_000,
  messages: 1_100,
})
const FABLE = tok('claude-fable-5', {
  cacheReadTokens: 40_000_000,
  outputTokens: 280_000,
  inputTokens: 30_000,
  messages: 400,
})

const session = (id: string, title: string, models: unknown[], running = false) => ({
  sessionId: id,
  title,
  harness: 'claude-code',
  running,
  models,
  firstTsMs: 0,
  lastTsMs: 1,
})

/** 1 · COSTED, LIVE, NO CHILDREN — the section's ordinary reading. */
const COSTED = {
  issueId: 'i-1574',
  state: 'costed',
  own: { models: [OPUS, FABLE], messages: 1_500, sessionCount: 10 },
  rollup: { models: [OPUS, FABLE], messages: 1_500, sessionCount: 10 },
  descendantCount: 0,
  provisional: true,
  floor: 'none',
  harnesses: ['claude-code'],
  sessions: [
    session('s-a', 'M2: Gallery grid and previews', [
      tok('claude-opus-5', { cacheReadTokens: 100_000_000, outputTokens: 320_000 }),
    ]),
    session(
      's-b',
      'Artifact gallery epic lead',
      [tok('claude-opus-5', { cacheReadTokens: 88_000_000, outputTokens: 240_000 })],
      true,
    ),
    session('s-c', 'M3: Collections and labels', [
      tok('claude-fable-5', { cacheReadTokens: 30_000_000, outputTokens: 200_000 }),
    ]),
    session('s-d', 'Review: M2 gallery grid', [
      tok('claude-opus-5', { cacheReadTokens: 24_000_000, outputTokens: 160_000 }),
    ]),
    session('s-e', 'Design: artifact gallery', [
      tok('claude-opus-5', { cacheReadTokens: 12_000_000, outputTokens: 90_000 }),
    ]),
    {
      ...session('s-f', null as unknown as string, [
        tok('claude-opus-5', { outputTokens: 180_000 }),
      ]),
      harness: 'codex',
    },
  ],
}

/** 2 · THE ROLLUP SPLIT AND THE FLOOR — POD-1402's shape, wholly Codex. */
const SOL_OWN = tok('gpt-5.6-sol', {
  cacheReadTokens: 220_000_000,
  outputTokens: 1_000_000,
  inputTokens: 400_000,
  messages: 1_775,
})
const SOL_ROLLUP = tok('gpt-5.6-sol', {
  cacheReadTokens: 400_000_000,
  outputTokens: 1_900_000,
  inputTokens: 700_000,
  messages: 3_100,
})
const SPLIT = {
  issueId: 'i-1402',
  state: 'costed',
  own: { models: [SOL_OWN], messages: 1_775, sessionCount: 6 },
  rollup: { models: [SOL_ROLLUP], messages: 3_100, sessionCount: 38 },
  descendantCount: 32,
  provisional: false,
  floor: 'partial',
  harnesses: ['codex'],
  sessions: [
    { ...session('s-1', 'POD-1402 epic lead', [SOL_OWN]), harness: 'codex' },
    {
      ...session('s-2', 'Review: rollout attribution', [
        tok('gpt-5.6-sol', { cacheReadTokens: 20_000_000 }),
      ]),
      harness: 'codex',
    },
  ],
}

/**
 * 3 · DESCENDANTS PRESENT, BUT own == rollup — POD-1574/1402/1403/1484 all read
 * this way today, because their descendants sit outside the 7-day harvest
 * window. The split is keyed on `descendantCount`, so the bar still draws and
 * still says "4 sub-tasks $0"; the empty segment is omitted rather than given a
 * 0% width, which would leave the rail's 1.5px gap stranded at one end.
 */
const FLAT = {
  issueId: 'i-1403',
  state: 'costed',
  own: { models: [OPUS], messages: 1_100, sessionCount: 4 },
  rollup: { models: [OPUS], messages: 1_100, sessionCount: 4 },
  descendantCount: 4,
  provisional: false,
  floor: 'none',
  harnesses: ['claude-code'],
  sessions: [session('s-g', 'The only session that has been read', [OPUS])],
}

/** 4 · PENDING — a transcript on disk that the harvest has not reached. Half of
 *  this machine's tasks are in this state right now, and it is NOT a spinner. */
const PENDING = {
  issueId: 'i-1867',
  state: 'pending',
  own: { models: [], messages: 0, sessionCount: 0 },
  rollup: { models: [], messages: 0, sessionCount: 0 },
  descendantCount: 0,
  provisional: false,
  floor: 'none',
  harnesses: [],
  sessions: [],
}

/** 5 · NO SESSIONS — a word, never a $0.00. */
const NONE = { ...PENDING, issueId: 'i-1608', state: 'no-sessions' }

const CASES: { id: string; seq: number; title: string; label: string; cost: unknown }[] = [
  {
    id: 'i-1574',
    seq: 1574,
    title: 'Session cost attribution',
    label: 'costed · live · no children',
    cost: COSTED,
  },
  {
    id: 'i-1402',
    seq: 1402,
    title: 'Artifact gallery epic',
    label: 'rollup split · floor',
    cost: SPLIT,
  },
  {
    id: 'i-1403',
    seq: 1403,
    title: 'Rollout attribution gaps',
    label: 'children, own == rollup',
    cost: FLAT,
  },
  {
    id: 'i-1867',
    seq: 1867,
    title: 'Chunked cost backfill',
    label: 'pending — drawn, unfilled',
    cost: PENDING,
  },
  { id: 'i-1608', seq: 1608, title: 'Explorer trail collapse', label: 'no sessions', cost: NONE },
]

state.issues = CASES.map((c) =>
  makeIssue({
    id: c.id,
    seq: c.seq,
    displayRef: `POD-${c.seq}`,
    title: c.title,
    stage: c.id === 'i-1574' ? 'in_progress' : 'review',
    description: 'A task whose cost the panel now accounts for.',
    activityNotes: 'The roster above lists only open sessions; the section below lists the rest.',
    notesUpdatedAt: '2026-09-01T09:12:00.000Z',
    updatedAt: '2026-09-01T09:12:00.000Z',
    memberSessionIds: c.id === 'i-1574' ? ['s-live-1', 's-live-2'] : [],
  }),
)

// Two OPEN sessions against a task the section says had ten — the exact case the
// roster's new meta line exists for.
state.sessions = [
  {
    sessionId: 's-live-1',
    issueId: 'i-1574',
    agentKind: 'claude-code',
    name: 'Artifact gallery epic lead',
    title: 'artifact gallery epic lead',
    cwd: '/r',
    archived: false,
    status: 'working',
    lastActiveAt: '2026-09-01T09:12:00.000Z',
  },
  {
    sessionId: 's-live-2',
    issueId: 'i-1574',
    agentKind: 'claude-code',
    name: 'UI review: the gallery',
    title: 'ui review: the gallery',
    cwd: '/r',
    archived: false,
    status: 'working',
    lastActiveAt: '2026-09-01T09:10:00.000Z',
  },
]

for (const c of CASES) state.costByIssue.set(c.id, c.cost)

// The cohort the "× median" reading is measured against. One row per task, built
// from OWN cost over OWN replies — the same function the sheet calls.
state.costRows = [
  {
    issueId: 'i-a',
    seq: 1,
    title: 'a',
    stage: 'done',
    models: [tok('claude-opus-5', { cacheReadTokens: 40_000_000, outputTokens: 120_000 })],
    messages: 900,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  },
  {
    issueId: 'i-b',
    seq: 2,
    title: 'b',
    stage: 'done',
    models: [tok('claude-opus-5', { cacheReadTokens: 20_000_000, outputTokens: 80_000 })],
    messages: 700,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 2,
    floor: 'none',
    harnesses: ['claude-code'],
  },
  {
    issueId: 'i-c',
    seq: 3,
    title: 'c',
    stage: 'done',
    models: [tok('gpt-5.6-sol', { cacheReadTokens: 60_000_000, outputTokens: 200_000 })],
    messages: 1_400,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 5,
    floor: 'partial',
    harnesses: ['codex'],
  },
]

function Column({ label, issueId }: { label: string; issueId: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 340, flex: '0 0 340px' }}>
      <div
        style={{
          padding: '8px 12px',
          font: '10px/1 var(--font-mono)',
          letterSpacing: '.09em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
        }}
      >
        {label}
      </div>
      <div
        data-right-dock-panel="issue"
        style={{
          flex: 1,
          minHeight: 0,
          borderLeft: '1px solid var(--border)',
          background: 'var(--engraved)',
          overflow: 'auto',
        }}
      >
        <IssuePanelView issueId={issueId} />
      </div>
    </div>
  )
}

function Harness(): JSX.Element {
  return (
    <ThemeProvider>
      <ConfirmProvider>
        <OperatorFocusProvider>
          <IssueExplorerProvider>
            <div
              style={{
                display: 'flex',
                height: '100vh',
                background: 'var(--background)',
                alignItems: 'stretch',
              }}
            >
              {CASES.map((c) => (
                <Column key={c.id} label={c.label} issueId={c.id} />
              ))}
            </div>
          </IssueExplorerProvider>
        </OperatorFocusProvider>
      </ConfirmProvider>
    </ThemeProvider>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
