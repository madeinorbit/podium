/**
 * The collapsed sidebar rail (#41, handoff 3a): the 52px column keeps the FULL
 * square language — one ID square per work row under the compact new-Claude
 * button, project groups reduced to bare hairlines, waiting counts as numbered
 * amber corner badges, working as the green spinner badge, and the selected
 * square still growing its bridge notch across the border into the engraved
 * column. Tooltips carry what the wide rows' text lost.
 *
 * The shell (#40) owns the 52px aside, the collapse flag and the ⟩ expand
 * control; this component fills the content below it.
 */

import { GitBranch, Search } from 'lucide-react'
import { type CSSProperties, Fragment, type JSX } from 'react'
import { NEW_AGENTS } from '@/app/NewPanelMenu'
import { useStoreSelector } from '@/app/store'
import { IdSquare, type IdSquareBadge, idSquareLabel } from '@/components/IdSquare'
import {
  groupUnifiedWorkRows,
  type MotionPhase,
  rowMotionPhase,
  rowStatusLine,
  rowWaitingCount,
  type UnifiedWorkRow,
} from '@/lib/derive'
import { FLOW_SLATE, issueColorHex } from '@/lib/issueColors'
import { cn } from '@/lib/utils'
import { useDefaultSpawn, useUnifiedWork } from './SidebarUnified'

/** The rail sits on the collapsed aside's surface — corner badges punch out of
 *  this colour (the --card sidebar background). */
const RAIL_SURFACE = '#16161c'

function railBadge(phase: MotionPhase, waitingCount: number): IdSquareBadge | null {
  if (waitingCount > 0) return { kind: 'count', count: waitingCount }
  if (phase === 'working') return { kind: 'spinner' }
  if (phase === 'done') return { kind: 'check' }
  return null
}

/** The selected square's bridge notch — same grammar as the wide row's, hung
 *  off the square and reaching across the rail border (handoff 3a). */
function RailNotch({ hex }: { hex: string | undefined }): JSX.Element {
  const accent = hex ?? FLOW_SLATE
  return (
    <span
      data-testid="bridge-notch"
      aria-hidden="true"
      // issue-scope + var-driven gradient: a fresh colour pick animates the
      // notch through the registered --issue transition (gradients themselves
      // can't interpolate).
      className="issue-scope pointer-events-none absolute top-[7px] right-[-14px] bottom-[7px] w-[10px] rounded-r-[3px]"
      style={
        {
          '--issue': accent,
          background: `linear-gradient(90deg, color-mix(in srgb, var(--issue) ${hex ? 85 : 75}%, transparent), color-mix(in srgb, var(--issue) ${hex ? 12 : 10}%, transparent))`,
        } as CSSProperties
      }
    />
  )
}

export function SidebarRail(): JSX.Element {
  const {
    work,
    selectedIssueId,
    selectedWorktree,
    selectIssue,
    selectWorktree,
    setIssueColor,
    now,
  } = useUnifiedWork()
  const { defaultAgent, defaultRepo, defaultTarget, spawn } = useDefaultSpawn()
  const setPaletteOpen = useStoreSelector((s) => s.setPaletteOpen)
  const AgentIcon = NEW_AGENTS.find((a) => a.kind === defaultAgent)?.Icon

  const renderRow = (row: UnifiedWorkRow): JSX.Element => {
    const phase = rowMotionPhase(row)
    const waitingCount = rowWaitingCount(row)
    const status = rowStatusLine(row, now)
    if (row.kind === 'issue') {
      const { issue } = row
      const selected = selectedIssueId === issue.id
      const label = idSquareLabel(issue)
      return (
        <span key={`issue:${issue.id}`} className="relative flex flex-none">
          <IdSquare
            issue={issue}
            state={phase}
            selected={selected}
            badge={railBadge(phase, waitingCount)}
            ringColor={RAIL_SURFACE}
            titleHint={`${label.full} ${issue.title} — ${selected ? 'selected, ' : ''}${
              waitingCount > 0 ? `${waitingCount} waiting` : status
            }`}
            onPrimary={() => selectIssue(issue)}
            onColorChange={(color) => setIssueColor(issue.id, color)}
          />
          {selected && <RailNotch hex={issueColorHex(issue.color)} />}
        </span>
      )
    }
    const { worktree } = row
    const selected = selectedIssueId === null && selectedWorktree === worktree.path
    const resting = phase === 'queued'
    const name = worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path
    return (
      <span key={`wt:${worktree.path}`} className="relative flex flex-none">
        <button
          type="button"
          data-testid="rail-worktree-square"
          className="phase-surface relative flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-[7px] bg-[#25252f]"
          style={{
            border: resting ? '1px dashed #6c6c78' : '1px solid #8d8d9a',
            color: resting ? '#8d8d9a' : '#c5c5d0',
            opacity: resting && !selected ? 0.6 : 1,
            boxShadow: selected ? '0 0 0 2px rgba(148,163,184,.3)' : undefined,
          }}
          title={`${name} — ${selected ? 'selected, ' : ''}${status}`}
          aria-label={`Open worktree ${name}`}
          onClick={() => selectWorktree(worktree.path)}
        >
          <GitBranch size={12} aria-hidden="true" />
        </button>
        {selected && <RailNotch hex={undefined} />}
      </span>
    )
  }

  return (
    <>
      {/* Compact new-Claude: the wide spawn row's primary action at 28px. */}
      <button
        type="button"
        data-testid="rail-new-agent"
        className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-lg border border-[#3a3a46] bg-[#25252f] transition-colors hover:border-[#4a4a56] hover:bg-[#2b2b36] disabled:opacity-50"
        disabled={!defaultRepo}
        title={defaultTarget ? `New agent in ${defaultTarget.repoName}` : 'No repos yet'}
        onClick={() => defaultRepo && spawn(defaultAgent, defaultRepo)}
      >
        {AgentIcon ? (
          <AgentIcon
            size={13}
            aria-hidden="true"
            className={cn(defaultAgent === 'claude-code' && 'text-claude')}
          />
        ) : null}
      </button>
      {/* The squares column leaves 3px of head-room past the aside edge so a
          selected square's notch paints over the border (same overflow trick as
          the wide list — clipping happens at the padding box). */}
      <div
        data-testid="sidebar-rail"
        className="scroll-none flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 overflow-y-auto pt-0.5 pb-1"
        style={{ marginRight: -6, paddingRight: 6 }}
      >
        {groupUnifiedWorkRows(work).map((group) => (
          <Fragment key={group.key}>
            <span
              data-testid="rail-project-hairline"
              className="h-px w-[26px] flex-none bg-[#25252f]"
              title={group.label}
            />
            {group.rows.flatMap((row) => {
              // Rail is flat: parent issue square then its started-by children
              // so provenance-nested work stays reachable without the wide tree.
              if (row.kind !== 'issue' || !row.startedByChildren?.length) {
                return [renderRow(row)]
              }
              return [renderRow(row), ...row.startedByChildren.map((c) => renderRow(c))]
            })}
          </Fragment>
        ))}
      </div>
      {/* Footer: the rail keeps only search from the four footer tools. */}
      <button
        type="button"
        className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md text-[#9a9aa8] transition-colors hover:bg-[#20202a] hover:text-[#f3f3f8]"
        title="Search (⌘K)"
        aria-label="Search"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={14} aria-hidden="true" />
      </button>
    </>
  )
}
