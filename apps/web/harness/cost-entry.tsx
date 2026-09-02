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
  messages: 770,
})
const FABLE = tok('claude-fable-5', {
  cacheReadTokens: 40_000_000,
  outputTokens: 280_000,
  inputTokens: 30_000,
  messages: 276,
})

const session = (id: string, title: string, models: unknown[], running = false) => ({
  sessionId: id,
  title,
  harness: 'claude-code',
  running,
  models,
  // Real timestamps: a session with no surviving row is labelled by its harness
  // and the DAY it ran, so a zero here would photograph a label that never ships.
  firstTsMs: Date.parse('2026-08-12T09:00:00Z'),
  lastTsMs: Date.parse('2026-08-12T17:30:00Z'),
})

/** 1 · COSTED, LIVE, NO CHILDREN — the section's ordinary reading. */
const COSTED = {
  issueId: 'i-1574',
  state: 'costed',
  own: { models: [OPUS, FABLE], messages: 1_046, sessionCount: 10 },
  rollup: { models: [OPUS, FABLE], messages: 1_046, sessionCount: 10 },
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
    // THE DELEGATE CASE (POD-1592). The read path attributes a subagent's
    // transcript to the session that SPAWNED it, so these three wire entries
    // share one id and must fold into ONE row summing to $50 — not three rows
    // on three identical React keys.
    session(
      's-b',
      'Artifact gallery epic lead',
      [tok('claude-opus-5', { cacheReadTokens: 30_000_000, outputTokens: 60_000 })],
      true,
    ),
    session(
      's-b',
      'Artifact gallery epic lead',
      [tok('claude-opus-5', { cacheReadTokens: 18_000_000, outputTokens: 40_000 })],
      true,
    ),
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
// THE COHORT, AT THE CORPUS'S REAL SHAPE.
//
// Five rows spanning the measured range ($0.030 to $0.255 per reply) with the
// MEDIAN sitting on the corpus's own $0.09346. The first draft of this fixture
// was three invented rows whose median came out at $0.0256 — 3.7x too cheap —
// and it made the panel print 5.9x for a task the read path reads at 2.31x.
// The panel's arithmetic was never wrong; the fixture under it was, and a
// screenshot of a wrong fixture is a wrong screenshot.
state.costRows = [
  {
    issueId: 'i-1',
    seq: 1,
    title: 'cohort 1',
    stage: 'done',
    // $0.030/reply
    models: [tok('claude-opus-5', { cacheReadTokens: 30_000_000 })],
    messages: 500,
    rollupModels: [tok('claude-opus-5', { cacheReadTokens: 30_000_000 })],
    rollupMessages: 500,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  },
  {
    issueId: 'i-2',
    seq: 2,
    title: 'cohort 2',
    stage: 'done',
    // $0.060/reply
    models: [tok('claude-opus-5', { cacheReadTokens: 96_000_000 })],
    messages: 800,
    rollupModels: [tok('claude-opus-5', { cacheReadTokens: 96_000_000 })],
    rollupMessages: 800,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  },
  {
    issueId: 'i-3',
    seq: 3,
    title: 'cohort 3',
    stage: 'done',
    // $0.09346/reply
    models: [tok('claude-opus-5', { cacheReadTokens: 186_920_000 })],
    messages: 1_000,
    rollupModels: [tok('claude-opus-5', { cacheReadTokens: 186_920_000 })],
    rollupMessages: 1_000,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  },
  {
    issueId: 'i-4',
    seq: 4,
    title: 'cohort 4',
    stage: 'done',
    // $0.150/reply
    models: [tok('claude-opus-5', { cacheReadTokens: 180_000_000 })],
    messages: 600,
    rollupModels: [tok('claude-opus-5', { cacheReadTokens: 180_000_000 })],
    rollupMessages: 600,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  },
  {
    issueId: 'i-5',
    seq: 5,
    title: 'cohort 5',
    stage: 'done',
    // $0.255/reply
    models: [tok('claude-opus-5', { cacheReadTokens: 459_000_000 })],
    messages: 900,
    rollupModels: [tok('claude-opus-5', { cacheReadTokens: 459_000_000 })],
    rollupMessages: 900,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  },
]

function Column({ label, issueId }: { label: string; issueId: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 340, flex: '0 0 340px' }}>
      {/* EVERY FIGURE IN THIS HARNESS IS INVENTED, and the crop says so.
          A screenshot of a stub was reviewed as if it were live, and the
          multiple it printed was read as a defect in the panel — it cost a
          review round. The banner travels with the frame so no crop of it can
          be mistaken for a reading of this machine. */}
      <div
        style={{
          padding: '8px 12px',
          font: '10px/1 var(--font-mono)',
          letterSpacing: '.09em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
        }}
      >
        <span style={{ color: 'var(--attention)' }}>FIXTURE</span> · {label}
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
                flexDirection: 'column',
                height: '100vh',
                background: 'var(--background)',
              }}
            >
              {/* Said once at the top of the frame as well as on every column,
                  so a full-width crop and a single-column crop both carry it. */}
              <div
                style={{
                  flex: '0 0 auto',
                  padding: '7px 12px',
                  font: '10px/1.4 var(--font-mono)',
                  letterSpacing: '.06em',
                  color: 'var(--text-faint)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span style={{ color: 'var(--attention)' }}>FIXTURE DATA</span> — every figure below
                is invented to exercise a state. Nothing here is a reading of this machine.
              </div>
              <div style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'stretch' }}>
                {CASES.map((c) => (
                  <Column key={c.id} label={c.label} issueId={c.id} />
                ))}
              </div>
            </div>
          </IssueExplorerProvider>
        </OperatorFocusProvider>
      </ConfirmProvider>
    </ThemeProvider>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
