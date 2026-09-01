import {
  formatCostWeightRatio,
  formatCount,
  formatShare,
  formatUsd,
  formatUsdExact,
  ISSUE_STAGE_LABELS,
  RATE_COHORT_MIN_REPLIES,
  type TaskCostRowView,
} from '@podium/client-core/viewmodels'
import type { CostHarness, IssueStage } from '@podium/model/browser'
import { type JSX, useMemo, useState } from 'react'
import { issueRefLabel } from '@/lib/issue-labels'
import { Unfilled } from './Unfilled'
import type { TaskCostsFeed } from './useTaskCosts'

/**
 * WHERE IT WENT — BY TASK. Provider is the coarse grouping of the window total;
 * this is the next one down, and it sits directly under it for that reason. Both
 * are above the trace, which answers a different question — when — and would
 * otherwise separate two halves of the same one.
 *
 * THE MASTHEAD IS CLOSED (POD-596, POD-755). The sheet leads with ONE figure at
 * the 24px step and nothing else on the surface takes it; a ramp that steps
 * everywhere steps nowhere. So the section's own headline reading is a cell in a
 * hairline-divided group at the sheet's 13px reading size, exactly as the reset
 * ledger's three readings are (QuotaLedger, POD-1571) — it leads its row by INK
 * and by position, not by size. That is the same instrument the masthead is,
 * minus its one licensed jump.
 *
 * WHAT THE FOUR READINGS ARE FOR. A total cannot say how many tasks it took, what
 * a normal one costs, how concentrated the spend is, or what the worst case was.
 * "Top 10 tasks" is the load-bearing one: it says whether the tail is where the
 * money is, and therefore whether the median is worth chasing at all.
 *
 * ONE READING IS THIS WINDOW'S AND THE REST ARE THE TASK'S WHOLE LIFE, which is
 * the section's one genuine seam and the note under the row states it outright.
 * "Attributed to a task" exists to be compared against the sheet's own 7-day
 * figure, so it MUST be the window fold (`windowCostUsd`) — an all-time per-task
 * total against a 7-day host total reads as over 100% attributed, which is a
 * category error rather than a rounding one. Everything else describes the
 * corpus the table below ranks, and the table is all-time because that is what a
 * task cost: a week's slice of an epic is not the epic's price.
 *
 * INK STEPS, NEVER HUE. High spend is worth a second look, which is exactly the
 * pull toward the attention colour that The Signal Rule refuses: yellow marks
 * what is asking something of the operator, and a ranking asks nothing. The
 * Composition ramp settled this once already (three of four rows lit gold made a
 * token price look like a decision waiting on you); the dearest task is the top
 * row, which is the whole point of ranking it.
 */

/** Which harness wrote a transcript, as the reader would name it. */
const HARNESS_LABEL: Record<CostHarness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
}

/** Rank by what a task cost, or by what a unit of its work cost. */
type Ranking = 'total' | 'rate'

export interface TaskCostStats {
  /** THIS WINDOW's spend that maps to a task — the one window reading here. */
  windowAttributedUsd: number
  /** Tasks with a figure at all. Never a count of tasks with a zero. */
  taskCount: number
  /** What a normal task costs. Median, not mean: the tail is enormous. */
  medianUsd: number | null
  /** The concentration reading — top ten as a share of every task's cost. */
  topTenShare: number | null
  /** The worst case, to the cent, so it matches the row it names. */
  dearestUsd: number | null
}

/**
 * The four readings and the window share, off ONE set of rows.
 *
 * `rows` must arrive dearest-first (`taskCostRows` sorts them), because the
 * concentration reading is the head of that order and the dearest is its first
 * element. Taking either from a differently-ordered copy is how a stats row
 * comes to disagree with the table it sits above.
 */
export function taskCostStats(rows: readonly TaskCostRowView[]): TaskCostStats {
  if (rows.length === 0) {
    return {
      windowAttributedUsd: 0,
      taskCount: 0,
      medianUsd: null,
      topTenShare: null,
      dearestUsd: null,
    }
  }
  const costs = rows.map((r) => r.estCostUsd).sort((a, b) => a - b)
  const mid = costs.length >> 1
  const median =
    costs.length % 2 === 1
      ? (costs[mid] as number)
      : ((costs[mid - 1] as number) + (costs[mid] as number)) / 2
  const total = costs.reduce((n, c) => n + c, 0)
  const topTen = rows.slice(0, 10).reduce((n, r) => n + r.estCostUsd, 0)
  return {
    windowAttributedUsd: rows.reduce((n, r) => n + r.windowCostUsd, 0),
    taskCount: rows.length,
    medianUsd: median,
    topTenShare: total > 0 ? topTen / total : null,
    dearestUsd: rows[0]?.estCostUsd ?? null,
  }
}

/**
 * A LOWER BOUND, AND WHY — two fields, never one enum (POD-1858).
 *
 * `floor` says the figure understates; `harnesses` says which transcripts it was
 * read from. The reason to keep them apart is that "all Codex" over a task that
 * also ran Grok would be a lie, and a task really can read `[codex, grok]`. Only
 * the non-Claude harnesses are named: every Claude transcript that carries usage
 * has a segment row, so a Claude session is never the reason a figure is short.
 */
function floorReason(harnesses: readonly CostHarness[]): string {
  const named = harnesses.filter((h) => h !== 'claude-code').map((h) => HARNESS_LABEL[h])
  const list =
    named.length === 0
      ? 'some'
      : named.length === 1
        ? (named[0] as string)
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  return `At least this much. Not every ${list} transcript is linked to a task, so this figure counts only what could be attributed to one.`
}

/**
 * One label-over-value cell of the section's divided group, with the three
 * states kept apart the way the reset ledger keeps them (QuotaLedger, POD-1571).
 *
 * `Unfilled` means NOT YET and is reserved for exactly that. A section that has
 * loaded and holds no task with a figure is a different fact — the answer is
 * known and it is nil — so it reads as a dash. An unfilled rule there would
 * promise a number that is never coming, and a `0` would claim the tasks were
 * read and came to nothing.
 */
function Reading({
  label,
  ch,
  loaded,
  value,
  lead,
}: {
  label: string
  ch: number
  loaded: boolean
  value: string | null
  lead?: boolean
}): JSX.Element {
  return (
    <div className="usage-reading" data-lead={lead || undefined}>
      <span className="usage-reading-label">{label}</span>
      <span className="usage-reading-value">
        {value !== null ? value : loaded ? '–' : <Unfilled ch={ch} />}
      </span>
    </div>
  )
}

export function UsageTasks({ feed, cold }: { feed: TaskCostsFeed; cold: boolean }): JSX.Element {
  const [ranking, setRanking] = useState<Ranking>('total')
  // A task with no counted tokens has no place in a ranking BY cost, and
  // printing it as `$0.00` is the sharpest way this feature can lie: the read
  // path keeps zero and "nothing recorded" as different facts precisely so the
  // surfaces never collapse them, and the sheet's own contribution is to let a
  // task with nothing to show simply not be a row.
  const byCost = useMemo(() => (feed.rows ?? []).filter((r) => r.estCostUsd > 0), [feed.rows])
  const ranked = useMemo(() => {
    if (ranking === 'total') return byCost
    // Ranked by rate, the cohort's entry bar becomes an ORDERING rule as well as
    // a comparison one. A task with three replies has a rate and it is noise —
    // one expensive turn moves it by a factor a reader would take for a finding
    // — so the qualifying tasks hold the head of the list and the rest follow in
    // their own order rather than topping a ranking they cannot support.
    const rate = (r: TaskCostRowView): number => r.ratePerReplyUsd ?? 0
    const qualifies = (r: TaskCostRowView): number => (r.messages > RATE_COHORT_MIN_REPLIES ? 1 : 0)
    return [...byCost].sort((a, b) => qualifies(b) - qualifies(a) || rate(b) - rate(a))
  }, [byCost, ranking])

  // THE READINGS ARE OFF THE COST ORDER, NEVER OFF THE CURRENT ONE. They
  // describe the corpus — how many tasks cost anything, what a normal one costs,
  // how concentrated the spend is, the worst case — and none of that is a fact
  // about how the table beneath them happens to be sorted. Taken off `ranked`,
  // "Dearest" would quietly become "the dearest of the ten fastest-burning" the
  // moment someone pressed Rate.
  const stats = useMemo(() => taskCostStats(byCost), [byCost])
  const loaded = feed.rows !== null && !cold
  // The rail measures whatever the table is ORDERED by. A rail measuring one
  // thing under a column ordered by another is two answers to one question —
  // the model table's own rule, and it survives a toggle only by moving with it.
  const railOf = (row: TaskCostRowView): number =>
    ranking === 'total' ? row.estCostUsd : (row.ratePerReplyUsd ?? 0)
  const railTop = Math.max(0, ...ranked.map(railOf))
  const floored = ranked.some((r) => r.floor === 'partial')
  // Three rows, for the reason the model table holds three: the table is the one
  // region whose LENGTH is unknown before the answer, and holding a plausible few
  // keeps the sheet from growing under the pointer.
  const placeholders = [0, 1, 2]

  return (
    <section className="usage-section usage-tasks">
      <h3 className="usage-section-head">
        Where it went
        <span className="usage-section-hint">
          by task · ranked by {ranking === 'total' ? 'cost' : 'rate'}
        </span>
        {/* The same segmented control the trace uses for Cost/Tokens: one idiom
            for "the same table, measured the other way", not a second one. */}
        <fieldset className="usage-measure-toggle" aria-label="Task ranking">
          <button
            type="button"
            className="usage-measure-button"
            data-pressable
            data-active={ranking === 'total' || undefined}
            aria-pressed={ranking === 'total'}
            onClick={() => setRanking('total')}
          >
            Total
          </button>
          <button
            type="button"
            className="usage-measure-button"
            data-pressable
            data-active={ranking === 'rate' || undefined}
            aria-pressed={ranking === 'rate'}
            onClick={() => setRanking('rate')}
          >
            Rate
          </button>
        </fieldset>
      </h3>

      <div className="usage-readings usage-task-readings">
        <Reading
          lead
          loaded={loaded}
          label="Attributed to a task"
          ch={6}
          value={loaded && stats.taskCount > 0 ? formatUsd(stats.windowAttributedUsd) : null}
        />
        {/* The one reading a loaded-but-empty section can still state: no task
            has a figure, and that is a count rather than an absent number. */}
        <Reading
          loaded={loaded}
          label="Tasks that cost"
          ch={3}
          value={loaded ? formatCount(stats.taskCount) : null}
        />
        <Reading
          loaded={loaded}
          label="Median task"
          ch={5}
          value={loaded && stats.medianUsd !== null ? formatUsd(stats.medianUsd) : null}
        />
        <Reading
          loaded={loaded}
          label="Top 10 tasks"
          ch={4}
          value={loaded && stats.topTenShare !== null ? formatShare(stats.topTenShare, 1) : null}
        />
        <Reading
          loaded={loaded}
          label="Dearest"
          ch={6}
          value={loaded && stats.dearestUsd !== null ? formatUsdExact(stats.dearestUsd) : null}
        />
      </div>
      {/* The seam, stated rather than left for the reader to trip over. It is one
          dim line in the sheet's interpretive voice, the way the cache
          counterfactual and the Grok note are. */}
      <p className="usage-task-note">
        Attribution is this window's; every figure below is what the task has cost altogether.
      </p>

      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col" className="usage-th-task">
                Task
              </th>
              <th scope="col" className="usage-th-stage">
                Stage
              </th>
              {/* Blank on purpose, exactly as the model table's is: the rail is
                  the same measure as the column the table is ranked by, drawn
                  instead of written. */}
              <th scope="col" />
              <th scope="col" className="usage-th-num">
                Sessions
              </th>
              <th scope="col" className="usage-th-num">
                Replies
              </th>
              <th
                scope="col"
                className="usage-th-num"
                title={`Cost per reply against the median task, over every task with more than ${RATE_COHORT_MIN_REPLIES} replies. Measured over each task's whole life, so the multiple means the same thing here as it does on the task itself.`}
              >
                Rate
              </th>
              <th scope="col" className="usage-th-num">
                API-equivalent
              </th>
            </tr>
          </thead>
          <tbody>
            {!loaded
              ? placeholders.map((r) => (
                  <tr key={r}>
                    <td className="usage-th-task">
                      <Unfilled ch={22} />
                    </td>
                    <td className="usage-th-stage">
                      <Unfilled ch={8} />
                    </td>
                    <td className="usage-td-share">
                      <span className="usage-share-track" />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={3} />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={5} />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={4} />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={7} />
                    </td>
                  </tr>
                ))
              : ranked.map((row) => (
                  <tr key={row.issueId}>
                    <td
                      className="usage-th-task usage-td-task"
                      title={`${issueRefLabel(row)} · ${row.title}`}
                    >
                      <span className="usage-td-task-inner">
                        <span className="usage-td-task-ref">{issueRefLabel(row)}</span> {row.title}
                      </span>
                    </td>
                    <td className="usage-th-stage usage-td-stage">
                      {ISSUE_STAGE_LABELS[row.stage as IssueStage] ?? row.stage}
                    </td>
                    <td className="usage-td-share">
                      <span className="usage-share-track">
                        <span
                          className="usage-share-fill"
                          style={{
                            width: `${railTop > 0 ? (railOf(row) / railTop) * 100 : 0}%`,
                          }}
                        />
                      </span>
                    </td>
                    <td className="usage-th-num">{formatCount(row.sessionCount)}</td>
                    <td className="usage-th-num">{formatCount(row.messages)}</td>
                    {/* A task below the cohort's entry bar still has a rate and
                        it is noise, so it prints no multiple rather than a
                        precise-looking one nothing supports. */}
                    <td className="usage-th-num usage-td-rate">
                      {row.messages > RATE_COHORT_MIN_REPLIES && row.rateVsMedian !== null
                        ? formatCostWeightRatio(row.rateVsMedian)
                        : '—'}
                    </td>
                    <td className="usage-th-num usage-td-cost">
                      {row.floor === 'partial' ? (
                        <span title={floorReason(row.harnesses)}>
                          <span className="usage-td-floor">≥</span> {formatUsdExact(row.estCostUsd)}
                        </span>
                      ) : (
                        formatUsdExact(row.estCostUsd)
                      )}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {loaded && ranked.length === 0 && (
        <p className="usage-task-note">
          No task has a cost on record yet. Figures appear as the harvest reads each session's
          transcript.
        </p>
      )}
      {floored && (
        <p className="usage-grok-note">
          ≥ marks a lower bound — not every Codex or Grok transcript is linked to a task.
        </p>
      )}
    </section>
  )
}
