/**
 * THE RESET LEDGER, REAL, IN A BROWSER (POD-1571).
 *
 * The figure is a pure function of its props, so no store stub is needed — this
 * renders the shipping component against the shipping `styles.css`. What it is
 * here to check is the part unit tests cannot see: that a groove reads as a
 * capacity with an unspent remainder, that a two-column strip does not inflate
 * into a slab, and that both themes come out of the same declarations.
 *
 * Four states side by side, because each has a different failure mode: cold,
 * loaded-but-empty, one sparse pool, and several pools with real spread.
 */

import { quotaLedger } from '@podium/client-core/viewmodels'
import type { QuotaWindowHistoryWire } from '@podium/model'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { QuotaLedger } from '@/features/usage/QuotaLedger'
import '@/index.css'
import '@/styles.css'

const WEEK_MS = 7 * 24 * 3_600_000

function row(over: Partial<QuotaWindowHistoryWire> = {}): QuotaWindowHistoryWire {
  const resetsAtMs = Date.parse(over.resetsAt ?? '2026-08-24T07:00:00.000Z')
  return {
    accountKey: 'codex::a@b.c',
    agent: 'codex',
    windowKey: 'weekly',
    label: 'Weekly',
    windowMinutes: 10080,
    startedAt: new Date(resetsAtMs - WEEK_MS).toISOString(),
    firstSeenAt: new Date(resetsAtMs - WEEK_MS).toISOString(),
    lastSeenAt: new Date(resetsAtMs).toISOString(),
    firstPercent: 0,
    peakPercent: 71,
    lastPercent: 71,
    sampleCount: 400,
    closed: true,
    partial: false,
    source: 'live',
    ...over,
    resetsAt: new Date(resetsAtMs).toISOString(),
  }
}

const week = (n: number) =>
  new Date(Date.parse('2026-08-24T07:00:00.000Z') - n * WEEK_MS).toISOString()

/** Several pools with real spread — the state the figure is designed around. */
const FULL = quotaLedger([
  ...[97, 100, 89, 100, 32, 71].map((peakPercent, i) =>
    row({
      resetsAt: week(5 - i),
      peakPercent,
      plan: i < 4 ? 'prolite' : 'pro',
      partial: i === 0,
    }),
  ),
  row({ resetsAt: week(-1), peakPercent: 1, closed: false, plan: 'pro' }),
  ...[74, 46].map((peakPercent, i) =>
    row({
      accountKey: 'claude-code::a@b.c',
      agent: 'claude-code',
      windowKey: 'weekly-all',
      resetsAt: week(1 - i),
      peakPercent,
      partial: i === 0,
      closed: i === 0,
    }),
  ),
  ...[93, 41].map((peakPercent, i) =>
    row({
      accountKey: 'grok::a@b.c',
      agent: 'grok',
      resetsAt: week(1 - i),
      peakPercent,
      closed: i === 0,
    }),
  ),
])

/** MIXED LENGTHS — the case POD-1743 exists for. A pool that reset after one
 *  day, two days, then a full week must show three visibly different widths. */
const MIXED = quotaLedger(
  (
    [
      [7, 88],
      [7, 61],
      [2, 34],
      [1, 12],
      [3, 55],
      [7, 91],
    ] as const
  ).map(([days, peak], i) =>
    row({
      accountKey: 'codex::a@b.c',
      agent: 'codex',
      resetsAt: new Date(Date.parse('2026-08-24T07:00:00.000Z') - (5 - i) * WEEK_MS).toISOString(),
      windowMinutes: days * 24 * 60,
      peakPercent: peak,
    }),
  ),
)

/** One pool, two weeks — the shape a fresh install has after a fortnight. */
const SPARSE = quotaLedger([
  row({ accountKey: 'grok::a@b.c', agent: 'grok', resetsAt: week(1), peakPercent: 93 }),
  row({
    accountKey: 'grok::a@b.c',
    agent: 'grok',
    resetsAt: week(0),
    peakPercent: 41,
    closed: false,
  }),
])

function Panel({
  title,
  theme,
  children,
}: {
  title: string
  theme: 'dark' | 'paper'
  children: JSX.Element
}): JSX.Element {
  return (
    // Paper is not a class: `index.css` keys the light palette on
    // `[data-theme="podium"]` and the dark one on `[data-theme="podium"].dark`,
    // so re-stamping the attribute WITHOUT `dark` on a subtree gives that subtree
    // the light token set. Same declarations, other theme — which is the point.
    <section
      {...(theme === 'paper' ? { 'data-theme': 'podium' } : {})}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <h2
        style={{
          margin: 0,
          font: '500 11px var(--font-mono)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}
      >
        {title}
      </h2>
      <div
        className="usage-body"
        style={{
          padding: '18px 20px',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
          background: 'var(--card)',
          color: 'var(--foreground)',
        }}
      >
        {children}
      </div>
    </section>
  )
}

function Shell(): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))',
        gap: 28,
        padding: 28,
        background: 'var(--background)',
        minHeight: '100vh',
      }}
    >
      <Panel title="Several pools · Dark Ink" theme="dark">
        <QuotaLedger ledger={FULL} cold={false} />
      </Panel>
      <Panel title="Several pools · Paper" theme="paper">
        <QuotaLedger ledger={FULL} cold={false} />
      </Panel>
      <Panel title="Mixed window lengths" theme="dark">
        <QuotaLedger ledger={MIXED} cold={false} />
      </Panel>
      <Panel title="One pool, two weeks" theme="dark">
        <QuotaLedger ledger={SPARSE} cold={false} />
      </Panel>
      <Panel title="Cold — read in flight" theme="dark">
        <QuotaLedger ledger={null} cold />
      </Panel>
      <Panel title="Loaded, nothing has reset yet" theme="dark">
        <QuotaLedger ledger={quotaLedger([])} cold={false} />
      </Panel>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Shell />)
