import { useActivityDisclosure } from '@podium/client-core/react'
import {
  type ActivityDisclosureProps,
  resolveToolEdit,
  toolCategory,
  toolExecutionView,
} from '@podium/client-core/values'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { useAgeNow } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'
import { CommandExecutionBlock } from './CommandExecutionBlock'
import { type ChatBlock, failLine, mcpLabel, toolSubject, toolVerdict } from './chat'
import { ToolEditDiff } from './ToolEditDiff'
import { ToolEffectNotes } from './ToolEffectNotes'
import { clockLabel, formatWorkDuration, fullTimeLabel, parseTs } from './transcript-time'
import { WorkGlyph } from './WorkGlyph'

export function toolCallLabel(item: TranscriptItem): string {
  return item.toolName ? (mcpLabel(item.toolName) ?? item.toolName) : 'result'
}

type ToolBlockProps = {
  block: ChatBlock
  live?: boolean | undefined
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
  onOpenDiff?: ((path: string) => void) | undefined
  diffPath?: string | undefined
  timed?: boolean | undefined
} & ActivityDisclosureProps

/** Commands consume only the shared adapter contract. File tools keep their
 * existing diff-sheet navigation and all other tools keep a quiet disclosure. */
export function ToolBlock(props: ToolBlockProps): JSX.Element {
  const execution = props.block.execution ?? toolExecutionView(props.block)
  return execution ? (
    <CommandExecutionBlock {...props} execution={execution} />
  ) : (
    <OtherToolBlock {...props} />
  )
}

function OtherToolBlock({
  block,
  onOpenDiff,
  diffPath,
  timed = false,
  forceOpen = false,
  onOpenChange,
  live = false,
  initialOpen,
}: ToolBlockProps): JSX.Element {
  const { userOpen, open, toggle } = useActivityDisclosure({ forceOpen, onOpenChange, initialOpen })
  const { item } = block
  const stamp = timed ? parseTs(item.ts) : undefined
  const result = block.result ?? item.toolResult
  const abnormal = item.toolEffects?.some(
    (effect) =>
      effect.kind === 'termination' && (effect.interrupted || effect.timedOutAfterMs !== undefined),
  )
  const verdict = toolVerdict(result, item.toolEffects, item.toolExecution)
  const edit = useMemo(() => (open ? resolveToolEdit(item) : undefined), [open, item])
  const subject = toolSubject(item, Number.POSITIVE_INFINITY)
  const openable = onOpenDiff && diffPath && !item.toolEffects?.length ? diffPath : undefined
  const activate = (): void => {
    if (openable && onOpenDiff) onOpenDiff(openable)
    else toggle()
  }
  return (
    <div
      className="work-line tool-block min-w-0"
      data-verdict={verdict}
      data-state={live ? 'live' : undefined}
      data-open={open ? 'true' : 'false'}
      data-transcript-retain={userOpen ? '' : undefined}
      data-transcript-run-view={forceOpen && !userOpen ? '' : undefined}
    >
      {stamp && (
        <time className="quiet-time" dateTime={item.ts} title={fullTimeLabel(stamp)}>
          {clockLabel(stamp)}
        </time>
      )}
      <button
        data-pressable
        type="button"
        className="work-line-row"
        data-transcript-run-toggle={forceOpen && !userOpen ? '' : undefined}
        onClick={activate}
        {...(openable ? { title: `Open ${openable}` } : { 'aria-expanded': open })}
      >
        <span
          className={cn('work-line-glyph', verdict === 'err' && 'work-line-glyph--err')}
          aria-hidden="true"
        >
          <WorkGlyph item={item} />
        </span>
        <span className="work-line-phrase">
          {subject ? `${toolCategory(item).verb} ${subject}` : toolCallLabel(item)}
        </span>
        {live ? (
          <ToolLiveTimer since={item.ts} />
        ) : (
          item.durationMs !== undefined && (
            <span className="work-line-time">{formatWorkDuration(item.durationMs)}</span>
          )
        )}
      </button>
      {verdict === 'err' && (
        <div className="tool-fail-line">
          {abnormal ? 'Tool interrupted or timed out' : failLine(result)}
        </div>
      )}
      {open && <ToolEffectNotes effects={item.toolEffects} />}
      {open && edit && <ToolEditDiff edit={edit} />}
      {open && (!edit || forceOpen) && (
        <pre className="tool-result-full">{result ?? '(no result captured)'}</pre>
      )}
      {open && edit && !forceOpen && verdict === 'err' && result && (
        <pre className="tool-result-full">{result}</pre>
      )}
    </div>
  )
}

function ToolLiveTimer({ since }: { since: string | undefined }) {
  const started = since ? Date.parse(since) : Number.NaN
  const known = Number.isFinite(started)
  const now = useAgeNow(started, 0, known, 3_600_000)
  return known ? (
    <span className="work-line-time">{formatWorkDuration(Math.max(0, now - started))}</span>
  ) : null
}
