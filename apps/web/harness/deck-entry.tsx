/**
 * THE FLIGHT DECK, REAL, IN A BROWSER AT EVERY WIDTH (POD-1226).
 *
 * The deck's open defects are all geometric — a rail that has to read as ONE
 * line from the mission header down to the last agent row, and four columns that
 * have to stay columns while the operator drags the column across its whole
 * 300–620px range. Neither can be measured where there is no layout, so this
 * mounts the shipping `FlightDeck` inside the shell's REAL wrapper chain
 * (`.desktop-shell` › `.desktop-shell-row` › the shell's width box › the
 * `ResizableColumn` root) against the real `styles.css`.
 *
 * Reproducing that chain is not decoration: the deck's own container queries key
 * off the used inline size of its rows, so a hand-rolled wrapper measures a
 * different ladder than the one that ships.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FlightDeck } from '@/app/FlightDeck'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { setHoveredSession } from '@/app/session-hover'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'
import { issue, session, state } from './deck-store-stub'

declare global {
  interface Window {
    deck: {
      setWidth: (px: number) => void
      /** Swap the fixture; `bump` re-renders against the new one. */
      setMission: (name: keyof typeof MISSIONS) => void
      setMode: (mode: 'full' | 'working' | 'needs-you' | 'waterfall') => void
      setDisplay: (display: 'compact' | 'expanded') => void
      setIssueColor: (hex: string | null) => void
      setTheme: (mode: 'light' | 'dark') => void
      point: (sessionId: string | null) => void
    }
  }
}

/**
 * The screenshot the operator filed (POD-1226): a planning mission whose one
 * agent is asking. That row carries every mark the gutter can hold at once —
 * the branch rail, the elbow, the selection tick and the attention rule — which
 * is exactly why it was the row that showed the collision.
 */
const MISSIONS = {
  /** The filed case, verbatim. */
  asking: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1211',
        title: 'JSON panel reading experience',
        stage: 'planning',
        memberSessionIds: ['s1'],
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1211-A',
        name: 'JSON panel UX direction',
        title: 'JSON panel UX direction',
        agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' },
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = 's1'
  },
  /**
   * THE OPERATOR'S SECOND FILING (POD-1306) — a DRAFT mission with one agent on
   * it, which is the thinnest the column ever gets. There is no tree yet, so
   * every line above the first row is chrome: it is the shape in which a stray
   * 16px descent under the gauge chip has nothing to be part of, and in which a
   * selection tick jammed against the agent tile is the only mark on screen.
   */
  draft: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1306',
        title: 'New session',
        stage: 'backlog',
        draft: true,
        memberSessionIds: ['s1'],
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1306-A',
        name: 'New session',
        title: 'New session',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = 's1'
  },
  /** The same mission with a full roster: a coordinator (coloured rail, filled
   *  row), a task lead, a spawned peer, a working agent, and sub-tasks — every
   *  cell of the four-column row occupied at once. */
  roster: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1211',
        title: 'JSON panel reading experience',
        stage: 'planning',
        memberSessionIds: ['s1', 's2'],
        coordinatorSessionId: 's1',
      }),
      issue('t1', {
        parentId: 'root',
        displayRef: 'POD-1212',
        title: 'Viewer folding and search',
        memberSessionIds: ['s3'],
        coordinatorSessionId: 's3',
      }),
      issue('t2', {
        parentId: 'root',
        displayRef: 'POD-1213',
        title: 'Reader tier for long payloads',
        memberSessionIds: ['s4', 's5'],
      }),
      issue('t3', { parentId: 't2', displayRef: 'POD-1214', title: 'Nested probe' }),
      issue('p1', {
        parentId: 'root',
        displayRef: 'POD-1215',
        stage: 'proposed',
        title: 'Split the payload panel',
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1211-A',
        name: 'Spine designer',
        title: 'Spine designer',
        agentState: {
          phase: 'working',
          since: new Date(Date.now() - 125_000).toISOString(),
          workingMsTotal: 900_000,
        },
      }),
      session('s2', {
        issueId: 'root',
        displayRef: 'POD-1211-B',
        name: 'JSON panel UX direction',
        title: 'JSON panel UX direction',
        agentState: {
          phase: 'needs_user',
          since: new Date(Date.now() - 640_000).toISOString(),
        },
      }),
      session('s3', {
        issueId: 't1',
        displayRef: 'POD-1212-A',
        name: 'Folding behaviour',
        title: 'Folding behaviour',
      }),
      session('s4', {
        issueId: 't2',
        displayRef: 'POD-1213-A',
        name: 'Reader tier measurements',
        title: 'Reader tier measurements',
        spawnedBy: 'session:s1',
      }),
      session('s5', {
        issueId: 't2',
        displayRef: 'POD-1213-B',
        name: 'Long payload sweep',
        title: 'Long payload sweep',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = 's2'
  },
  /**
   * THE OPERATOR'S FILED ROSTER (POD-1461) — the demo rig's MRD-2, verbatim.
   *
   * Four agents directly on one mission and no sub-tasks, so the roster IS the
   * spine: every one of the four fields is occupied on at least one row (a
   * long spawn provenance, a bare peer, a done total, an ask) and the ARCHIVED
   * divider follows immediately underneath. It is the shape the operator
   * called cluttered, which makes it the shape any alignment fix has to hold.
   */
  mrd: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'MRD-2',
        title: 'Migrate sessions store from SQLite to Postgres',
        description: 'Dual-write behind a flag, backfill, then cut over. Needs a rollback plan.',
        stage: 'in_progress',
        memberSessionIds: ['s1', 's2', 's3', 's4', 'a1', 'a2', 'a3'],
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'MRD-2-D',
        name: 'Migration coordinator',
        title: 'Migration coordinator',
        agentState: {
          // The running clock is driven by the real wall clock, not the stub's
          // frozen `coarseNow`, so the fixture's 82:00 has to be anchored to it.
          phase: 'working',
          since: new Date(Date.now() - 60_000).toISOString(),
          workingMsTotal: 4_860_000,
        },
      }),
      session('s2', {
        issueId: 'root',
        displayRef: 'MRD-2-E',
        name: 'Dual-write layer',
        title: 'Dual-write layer',
        spawnedBy: 'session:s1',
        unread: true,
        lastActiveAt: '2025-12-31T23:30:00.000Z',
      }),
      session('s3', {
        issueId: 'root',
        displayRef: 'MRD-2-F',
        name: 'Backfill job',
        title: 'Backfill job',
        spawnedBy: 'session:s1',
        unread: true,
        agentState: {
          phase: 'ended',
          since: new Date(Date.now() - 60_000).toISOString(),
          workingMsTotal: 165_000,
        },
      }),
      session('s4', {
        issueId: 'root',
        displayRef: 'MRD-2-G',
        name: 'Rollback runbook',
        title: 'Rollback runbook',
        agentState: { phase: 'needs_user', since: '2025-12-31T23:30:00.000Z' },
      }),
      // The three the reveal counts. Archived sessions never draw in the tree.
      session('a1', {
        issueId: 'root',
        displayRef: 'MRD-2-A',
        name: 'Schema survey',
        title: 'Schema survey',
        archived: true,
        lastActiveAt: '2025-12-30T00:00:00.000Z',
      }),
      session('a2', {
        issueId: 'root',
        displayRef: 'MRD-2-B',
        name: 'Connection pool spike',
        title: 'Connection pool spike',
        archived: true,
        lastActiveAt: '2025-12-30T00:00:00.000Z',
      }),
      session('a3', {
        issueId: 'root',
        displayRef: 'MRD-2-C',
        name: 'Wire format check',
        title: 'Wire format check',
        archived: true,
        lastActiveAt: '2025-12-30T00:00:00.000Z',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = 's1'
  },
  /**
   * THE VIEW BAR'S OWN CASE (POD-1245) — a mission shaped like the one an
   * operator filed `Active` against.
   *
   * Every finished task here keeps an agent, because that is what a real
   * mission looks like: agents park, they do not exit. `t1` and `t2` are over
   * and their agents are merely hibernating (nothing to see on `Active`); `t3`
   * is over but an agent is genuinely mid-turn on it (the escape hatch, which
   * must still show); `t4` is live. `t5` is a DONE parent whose child is in
   * review — the path case `Needs you` has to draw without letting the parent
   * look like it is asking too.
   */
  filters: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1211',
        title: 'JSON panel reading experience',
        stage: 'planning',
        memberSessionIds: ['s1'],
      }),
      issue('t1', {
        parentId: 'root',
        displayRef: 'POD-1212',
        title: 'Viewer folding and search',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s2'],
      }),
      issue('t2', {
        parentId: 'root',
        displayRef: 'POD-1213',
        title: 'Payload panel split',
        stage: 'done',
        closedReason: 'cancelled',
        memberSessionIds: ['s3'],
      }),
      issue('t3', {
        parentId: 'root',
        displayRef: 'POD-1214',
        title: 'Reader tier for long payloads',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s4'],
      }),
      issue('t4', {
        parentId: 'root',
        displayRef: 'POD-1215',
        title: 'Syntax theme tokens',
        memberSessionIds: ['s5'],
      }),
      issue('t5', {
        parentId: 'root',
        displayRef: 'POD-1216',
        title: 'Copy affordances',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s6', 's7'],
      }),
      issue('t6', {
        parentId: 't5',
        displayRef: 'POD-1217',
        title: 'Copy-as-path menu item',
        stage: 'review',
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1211-A',
        name: 'Spine designer',
        title: 'Spine designer',
        agentState: { phase: 'working', since: '2026-01-01T00:28:00.000Z' },
      }),
      // Parked after finishing — the shape that used to re-admit a done task.
      session('s2', {
        issueId: 't1',
        displayRef: 'POD-1212-A',
        name: 'Folding behaviour',
        title: 'Folding behaviour',
        status: 'hibernated',
      }),
      session('s3', {
        issueId: 't2',
        displayRef: 'POD-1213-A',
        name: 'Panel split probe',
        title: 'Panel split probe',
        status: 'hibernated',
      }),
      // Genuinely mid-turn on a closed task: the escape hatch, still open.
      session('s4', {
        issueId: 't3',
        displayRef: 'POD-1214-A',
        name: 'Reader tier measurements',
        title: 'Reader tier measurements',
        agentState: { phase: 'working', since: '2026-01-01T00:20:00.000Z' },
      }),
      session('s5', {
        issueId: 't4',
        displayRef: 'POD-1215-A',
        name: 'Token sweep',
        title: 'Token sweep',
        agentState: { phase: 'working', since: '2026-01-01T00:25:00.000Z' },
      }),
      session('s6', {
        issueId: 't5',
        displayRef: 'POD-1216-A',
        name: 'Copy affordance pass',
        title: 'Copy affordance pass',
        agentState: { phase: 'working', since: '2026-01-01T00:26:00.000Z' },
      }),
      session('s7', {
        issueId: 't5',
        displayRef: 'POD-1216-B',
        name: 'Menu wording',
        title: 'Menu wording',
        status: 'hibernated',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * THE FILED CASE FOR POD-1452 — the operator's screenshot, verbatim.
   *
   * One mission in `review`, its only agent finished and wearing the ✓, and one
   * proposed spinoff hanging off it. `Working` — `Active`, as it was then
   * called — showed all of it, because it matched the TASK (open) and then
   * handed the row its whole crew without asking anything about the agent.
   * Nothing here is being worked: the view should be the header, its own
   * sentence, and nothing else.
   */
  agentFilters: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1429',
        title: 'Bug: Mobile Import Syntax',
        description:
          'Two mobile component suites fail during module import before collecting tests.',
        stage: 'review',
        memberSessionIds: ['s1'],
      }),
      issue('p1', {
        parentId: 'root',
        displayRef: 'POD-1437',
        stage: 'proposed',
        title: 'Bug: MobileSyncBoundary render leak',
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1429-A',
        name: 'Typeof syntax error at import',
        title: 'Typeof syntax error at import',
        agentState: {
          phase: 'idle',
          since: '2026-01-01T00:00:00.000Z',
          idle: { kind: 'done' },
          workingMsTotal: 1_018_000,
        },
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * THE SAME RULE WITH SOMETHING TO COMPARE (POD-1452) — one mission carrying
   * every agent state the bar sorts on, so the three views can be read side by
   * side rather than as one empty column.
   *
   * `Full spine` shows five agents. `Working` keeps the one mid-turn and drops
   * every other — the finished ✓, the parked one, the one standing by, and the
   * one stopped on an offer. That last belongs to `Needs you`, which is what
   * makes the two tabs disjoint: `Needs you` keeps the asker, plus `t4`'s row,
   * which is in review with nobody left on it and is an obligation the operator
   * still owns.
   */
  agentFiltersMix: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1429',
        title: 'Bug: Mobile Import Syntax',
        stage: 'in_progress',
        memberSessionIds: ['s1'],
      }),
      issue('t1', {
        parentId: 'root',
        displayRef: 'POD-1430',
        title: 'Native globals in the RN lane',
        memberSessionIds: ['s2'],
      }),
      issue('t2', {
        parentId: 'root',
        displayRef: 'POD-1431',
        title: 'Suite import order',
        memberSessionIds: ['s3'],
      }),
      issue('t3', {
        parentId: 'root',
        displayRef: 'POD-1432',
        title: 'Mock factory keys',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s4'],
      }),
      issue('t4', {
        parentId: 'root',
        displayRef: 'POD-1433',
        title: 'Sync boundary teardown',
        stage: 'review',
        memberSessionIds: ['s5'],
      }),
      issue('t5', {
        parentId: 'root',
        displayRef: 'POD-1434',
        title: 'Transform cache warmup',
        stage: 'backlog',
      }),
    ]
    state.sessions = [
      // Finished its turn, still here, still wearing the ✓ — the filed case.
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1429-A',
        name: 'Typeof syntax error at import',
        title: 'Typeof syntax error at import',
        agentState: {
          phase: 'idle',
          since: '2026-01-01T00:00:00.000Z',
          idle: { kind: 'done' },
          workingMsTotal: 1_018_000,
        },
      }),
      session('s2', {
        issueId: 't1',
        displayRef: 'POD-1430-A',
        name: 'Globals sweep',
        title: 'Globals sweep',
        // The working timer counts from the WALL clock, not from the stub's
        // frozen `now`, so a fixed `since` renders a five-digit hour count.
        agentState: { phase: 'working', since: new Date(Date.now() - 214_000).toISOString() },
      }),
      session('s3', {
        issueId: 't2',
        displayRef: 'POD-1431-A',
        name: 'Import order probe',
        title: 'Import order probe',
        // Wall-clock, like the working `since` above: an ask with no agentState
        // dates its timer off `lastActiveAt`, and a fixed one prints "232d ago".
        lastActiveAt: new Date(Date.now() - 640_000).toISOString(),
        offer: { message: 'Ready to merge', actions: [], createdAt: '2026-01-01T00:20:00.000Z' },
      }),
      // Parked on a finished task: not asking, not working, not going.
      session('s4', {
        issueId: 't3',
        displayRef: 'POD-1432-A',
        name: 'Mock key audit',
        title: 'Mock key audit',
        status: 'hibernated',
      }),
      // Standing by: alive, attached, and doing nothing at all.
      session('s5', {
        issueId: 't4',
        displayRef: 'POD-1433-A',
        name: 'Teardown review',
        title: 'Teardown review',
        agentState: {
          phase: 'idle',
          since: '2026-01-01T00:10:00.000Z',
          idle: { kind: 'done' },
        },
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * THE FILED CASE FOR POD-1314 — one task, in progress, its only agent exited.
   *
   * Four devices on one header, three of them right: a `no agent` seat, a
   * `0 agents` crew chip, a row reading `Retired · 6m ago` — and a gauge across
   * the middle of them reading `1 UNDERWAY`. It is also the row whose state cell
   * wrapped to two lines, so this one fixture carries both halves of the issue.
   */
  stalled: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1310',
        title: 'New Task modal in Task tool',
        description:
          'remove "default" behind default model, remove "RUNS ON" from start work, make sure the harness selector greys out unavailable harnesses.',
        stage: 'in_progress',
        memberSessionIds: ['s1'],
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1310-A',
        name: 'New session',
        title: 'New session',
        status: 'exited',
        // Six minutes before the stub's `now`, so the stamp is the filed one.
        lastActiveAt: '2026-01-01T00:24:00.000Z',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * The same split with something to compare it against: a task an agent is
   * genuinely working, a task whose agent left, a blocked task and an untouched
   * one — so `UNDERWAY`, `STALLED`, `BLOCKED` and `TO GO` are on one track and
   * the new band has to hold its own beside the three it sits between.
   */
  stalledMix: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1310',
        title: 'New Task modal in Task tool',
        stage: 'in_progress',
      }),
      issue('t1', {
        parentId: 'root',
        displayRef: 'POD-1311',
        title: 'Harness selector greying',
        memberSessionIds: ['s1'],
      }),
      issue('t2', {
        parentId: 'root',
        displayRef: 'POD-1312',
        title: 'Default model chip',
        memberSessionIds: ['s2'],
      }),
      issue('t3', {
        parentId: 'root',
        displayRef: 'POD-1313',
        title: 'Linear link removal',
        blocked: true,
      }),
      issue('t4', {
        parentId: 'root',
        displayRef: 'POD-1315',
        title: 'Start-work copy',
        stage: 'backlog',
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 't1',
        displayRef: 'POD-1311-A',
        name: 'Selector pass',
        title: 'Selector pass',
        agentState: { phase: 'working', since: '2026-01-01T00:22:00.000Z' },
      }),
      session('s2', {
        issueId: 't2',
        displayRef: 'POD-1312-A',
        name: 'New session',
        title: 'New session',
        status: 'exited',
        lastActiveAt: '2026-01-01T00:24:00.000Z',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * THE MISSION THAT IS SIMPLY OVER (POD-1268) — the filed screenshot: a task
   * withdrawn, its session retired, no sub-task and no destination. The spine
   * has nothing to draw, which is exactly why the ending has to be a card in it
   * rather than a caption under it.
   */
  retired: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1261',
        title: 'Eager bundle budget is red on main',
        description:
          'Not a real defect — withdrawn. The red budget was measured against origin/main, which is not this host\u2019s landing line; local main already carries the bundle paydown that fixes it.',
        stage: 'done',
        closedReason: 'cancelled',
        deps: [{ id: 'origin', type: 'discovered-from' }],
      }),
      issue('origin', { id: 'origin', displayRef: 'POD-1257', title: 'Bundle paydown' }),
    ]
    state.sessions = []
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * THE FILED CASE FOR POD-1455 — a mission whose description is a WRITTEN
   * BRIEF: an opening line, a blank line, then a bullet list. Every other
   * fixture here carries one flat sentence, which is why the header's prose
   * block could ship as a `<p>` for so long: with no newline in the string
   * there was nothing for `white-space` to lose. This one has both, so the
   * paragraph break and the list markers are measurable rather than asserted.
   */
  prose: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1451',
        title: 'Live footer metrics',
        stage: 'review',
        description:
          'in the footer bar: make sure:\n\n- agents count is based on "now" / live (can also be last minute or something, don\u2019t risk performance). but, definitely not an avg over last 12h or so\n- burn: the same\n\nremove:\n\n- ships/day\n- work in worktree',
        memberSessionIds: ['s1'],
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1451-A',
        name: 'Live Footer Metrics',
        title: 'Live Footer Metrics',
        status: 'exited',
        lastActiveAt: '2026-01-01T00:24:00.000Z',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
  },
  /**
   * THE SAME BRIEF, PASTED RATHER THAN WRITTEN — the extreme the header's cap
   * exists for. Nobody types this into a task description, but people paste
   * specs into them, and the only limit the deck keeps is that a brief may not
   * take so much of the window that the spine has nowhere to be. This is the
   * fixture that makes that cap bind, and the fade with it.
   */
  proseLong: () => {
    MISSIONS.prose()
    const root = state.issues[0] as Record<string, unknown>
    root.description = [
      'in the footer bar, the readouts have drifted apart and each one needs its own decision:',
      '',
      '- agents count is based on "now" / live (can also be last minute or something, don\u2019t risk performance). but, definitely not an avg over last 12h or so',
      '- burn: the same \u2014 it is a rate, and a rate averaged over half a day is a different quantity from the one the label promises',
      '- ships/day was measured against a window nobody chose; it reads as a target and it is not one',
      '- work in worktree double-counts a worktree two sessions share',
      '',
      'remove outright:',
      '',
      '- ships/day',
      '- work in worktree',
      '',
      'and once those are gone, check the bar still balances at 300px: the readouts left have to shed words before they shed data, the way the command bar does.',
    ].join('\n')
  },
} as const

/**
 * THE THEME IS AN ATTRIBUTE, NOT A DEFAULT (POD-1455).
 *
 * Every token in `index.css` hangs off `[data-theme="podium"]` — the app sets it
 * in `theme.tsx` — so a harness page that only imports the stylesheet renders
 * with NO surface, NO ink ramp and NO seams: an untokenized white page that
 * looks close enough to Paper to be mistaken for it. Dark is the app's own
 * default, so that is what the harness opens in; `window.deck.setTheme` swaps.
 */
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.add('dark')

function Harness(): JSX.Element {
  const [width, setWidth] = useState(366)
  const [display, setDisplay] = useState<'compact' | 'expanded'>('compact')
  const [mission, setMission] = useState<keyof typeof MISSIONS>('asking')
  const [color, setColor] = useState<string | null>(null)
  const [, bump] = useState(0)

  MISSIONS[mission]()

  const changeDisplay = useCallback((next: 'compact' | 'expanded'): void => {
    setDisplay(next)
    setWidth(next === 'expanded' ? 680 : 366)
  }, [])

  useEffect(() => {
    window.deck = {
      setWidth: (px) => setWidth(px),
      setMission: (name) => {
        setMission(name)
        bump((v) => v + 1)
      },
      // The view bar's own state is persisted UI state, so the harness sets it
      // the way the app does rather than reaching into the component.
      setMode: (mode) => {
        state.ui.set('podium.flightDeck.mode', mode === 'full' ? null : mode)
        bump((v) => v + 1)
      },
      setDisplay: changeDisplay,
      setIssueColor: (hex) => setColor(hex),
      setTheme: (mode) => {
        document.documentElement.classList.toggle('dark', mode === 'dark')
      },
      // `setHoveredSession(null)` IS the clear; `clearHoveredSession` is the
      // guarded form a row uses on pointer-out and needs its own id.
      point: (id) => setHoveredSession(id as never),
    }
  }, [changeDisplay])

  return (
    <div
      className="desktop-shell issue-scope"
      data-issue-colored={color ? 'true' : 'false'}
      style={{ '--issue': color ?? 'var(--flow)' } as never}
    >
      {/* The shell spends its top bar and status strip before the row gets any
          height; a harness without them hands the deck a taller pane than
          production and every vertical number comes out optimistic. */}
      <div style={{ height: 'var(--topbar-h)', flex: 'none' }} />
      <div className="desktop-shell-row">
        <div
          className="flex min-h-0 min-w-0 flex-[0_1_auto] overflow-hidden"
          data-flight-deck-shell="open"
          style={{ width }}
        >
          <div
            className={`relative flex min-w-0 flex-[0_1_auto] ${
              display === 'expanded' ? 'max-w-[62vw]' : 'max-w-[45vw]'
            }`}
            data-flight-deck-display={display}
            data-resizable-column="podium:superagent:width"
            style={{ width }}
          >
            <OperatorFocusProvider missionId="root">
              <ConfirmProvider>
                <FlightDeck
                  onCollapse={() => {}}
                  display={display}
                  onDisplayChange={changeDisplay}
                />
              </ConfirmProvider>
            </OperatorFocusProvider>
          </div>
        </div>
        <div className="min-w-0 flex-1" />
      </div>
      <div style={{ height: 'var(--status-strip-h)', flex: 'none' }} />
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
