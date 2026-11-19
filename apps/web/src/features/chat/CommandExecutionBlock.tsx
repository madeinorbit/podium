import { highlightCode } from '@podium/client-core/code-highlight'
import { useActivityDisclosure } from '@podium/client-core/react'
import {
  type ActivityDisclosureProps,
  type ChatBlock,
  resolveToolEdit,
  type ToolExecutionView,
  toolVerdict,
} from '@podium/client-core/values'
import { Check, ChevronRight, Copy, Info, WrapText } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAgeNow } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'
import { ExecutionOutputText } from './ExecutionOutputText'
import { ToolEditDiff } from './ToolEditDiff'
import { ToolEffectNotes } from './ToolEffectNotes'
import { clockLabel, formatWorkDuration, fullTimeLabel, parseTs } from './transcript-time'
import { WorkGlyph } from './WorkGlyph'
import './command-execution.css'

function CommandCode({ text, shell }: { text: string; shell: boolean }): JSX.Element {
  const tokens = useMemo(() => (shell ? highlightCode(text, 'bash') : [{ text }]), [text, shell])
  let offset = 0
  return (
    <>
      {tokens.map((token) => {
        const key = offset
        offset += token.text.length
        return (
          <span
            key={key}
            className={
              'scope' in token && token.scope
                ? `hljs-${String(token.scope).replaceAll('.', '-')}`
                : undefined
            }
          >
            {token.text}
          </span>
        )
      })}
    </>
  )
}

export function ExecutionCopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [feedback, setFeedback] = useState<'copied' | 'failed'>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    [],
  )
  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setFeedback('copied')
    } catch {
      setFeedback('failed')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFeedback(undefined), 1800)
  }
  return (
    <span className="execution-copy">
      <button
        data-pressable
        type="button"
        className="execution-action"
        aria-label={label}
        title={label}
        onClick={() => {
          void copy()
        }}
      >
        {feedback === 'copied' ? (
          <Check size={12} aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
        <span>
          {feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed' : 'Copy'}
        </span>
      </button>
      <span className="sr-only" role="status">
        {feedback === 'copied'
          ? `${label}: copied`
          : feedback === 'failed'
            ? 'Unable to copy. Select the text to copy it.'
            : ''}
      </span>
    </span>
  )
}

/** This component knows only the shared execution contract. A script and a
 * single command use the same frame, disclosure, capture cues and output well. */
export function CommandExecutionBlock({
  block,
  execution,
  timed = false,
  live = false,
  forceOpen,
  initialOpen,
  onOpenChange,
}: {
  block: ChatBlock
  execution: ToolExecutionView
  timed?: boolean | undefined
  live?: boolean | undefined
} & ActivityDisclosureProps): JSX.Element {
  const { userOpen, open, toggle } = useActivityDisclosure({ forceOpen, initialOpen, onOpenChange })
  const id = useId()
  const [wrap, setWrap] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const { item } = block
  const { inputs, output } = execution
  const first = inputs[0]!
  const single = execution.count === 1
  const preview =
    first.kind === 'command'
      ? first.text.split('\n')[0] || execution.label
      : first.kind === 'continuation'
        ? `${execution.label} (${first.text})`
        : first.toolName
  const stamp = timed ? parseTs(item.ts) : undefined
  const result = block.result ?? item.toolResult
  const verdict = toolVerdict(result, item.toolEffects, item.toolExecution)
  const status =
    live && (execution.status === 'unknown' || execution.status === 'running')
      ? 'running'
      : execution.status
  const statusLabel =
    status === 'completed'
      ? 'Completed'
      : status === 'failed'
        ? 'Failed'
        : status === 'interrupted'
          ? 'Interrupted'
          : status === 'running'
            ? 'Running'
            : status === 'returned'
              ? 'Returned'
              : undefined
  const edit = useMemo(() => (open ? resolveToolEdit(item) : undefined), [open, item])
  const previewLines = 8
  const longOutput = output.lines > previewLines
  const outputText =
    showAll || !longOutput
      ? output.text
      : output.text?.split('\n').slice(0, previewLines).join('\n')
  const title = single ? first.description || preview : execution.label
  const accessibleTitle = title.length > 160 ? `${title.slice(0, 160)}…` : title
  return (
    <div
      className="command-execution tool-block"
      data-execution={item.id}
      data-open={open ? 'true' : 'false'}
      data-verdict={verdict}
      data-state={status === 'running' ? 'live' : undefined}
      data-transcript-retain={userOpen ? '' : undefined}
      data-transcript-run-view={forceOpen && !userOpen ? '' : undefined}
    >
      <button
        type="button"
        data-pressable
        className="execution-heading work-line-row"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${accessibleTitle}`}
        aria-describedby={`${id}-facts`}
        onClick={toggle}
        data-transcript-run-toggle={forceOpen && !userOpen ? '' : undefined}
      >
        <span className="work-line-glyph" aria-hidden="true">
          <WorkGlyph item={item} />
        </span>
        <span
          className={cn(
            'execution-title work-line-phrase',
            single && first.kind === 'command' && !first.description && 'work-line-code',
          )}
        >
          {single ? (
            <>
              {first.description && (
                <span className="execution-description">{first.description} </span>
              )}
              <span className={first.description ? 'execution-command-preview' : undefined}>
                {first.description ? `(${preview})` : preview}
              </span>
            </>
          ) : (
            <>
              <span className="execution-run-name">Run</span>
              <span className="execution-input-count">{execution.label}</span>
            </>
          )}
        </span>
        <span className="execution-facts" id={`${id}-facts`}>
          <span className="execution-output-cue" data-capture={output.capture}>
            {output.label}
          </span>{' '}
          {statusLabel && (
            <span className="execution-status" data-status={status} title={statusLabel}>
              {status === 'completed' && <Check size={11} aria-hidden="true" />}
              <span>{statusLabel}</span>
            </span>
          )}{' '}
          {status === 'running' && live ? (
            <ExecutionLiveDuration since={item.ts} />
          ) : (
            execution.durationMs !== undefined && (
              <span className="execution-duration">
                {execution.durationMs > 0 && execution.durationMs < 1000
                  ? `${Math.round(execution.durationMs)}ms`
                  : formatWorkDuration(execution.durationMs)}
              </span>
            )
          )}{' '}
          {stamp && (
            <time className="execution-timestamp" dateTime={item.ts} title={fullTimeLabel(stamp)}>
              <span className="execution-timestamp-label">At</span> {clockLabel(stamp)}
            </time>
          )}
        </span>
        <ChevronRight className="execution-chevron" size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="execution-body" id={`${id}-body`}>
          <section
            className="execution-inputs"
            aria-label={
              execution.kind === 'commands'
                ? single
                  ? 'Command'
                  : 'Commands'
                : execution.kind === 'continuation'
                  ? 'Continuation'
                  : 'Inputs'
            }
          >
            <div className="execution-section-heading">
              <span>
                {execution.kind === 'commands'
                  ? single
                    ? 'Command'
                    : 'Commands'
                  : execution.kind === 'continuation'
                    ? 'Continuation'
                    : 'Inputs'}
              </span>
            </div>
            <ol className="execution-input-list">
              {inputs.map((input, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: inputs retain their recorded order within one execution.
                <li className="execution-input" key={`${item.id}-${index}`} data-input-of={item.id}>
                  <div className="execution-input-content">
                    {!single &&
                      (input.description || block.scriptCalls?.[index]?.tool === 'Mail') && (
                        <div className="execution-input-description">
                          {input.description ?? block.scriptCalls?.[index]?.input}
                        </div>
                      )}
                    <pre className="tool-cmd execution-command" data-kind={input.kind}>
                      <CommandCode text={input.text} shell={input.kind === 'command'} />
                    </pre>
                    {input.capture !== 'complete' && (
                      <p className="execution-input-note">
                        {input.capture === 'truncated'
                          ? 'Command truncated — remaining text was not retained.'
                          : 'The record may contain only an input preview.'}
                      </p>
                    )}
                  </div>
                  <ExecutionCopyButton
                    text={input.text}
                    label={
                      input.capture === 'complete'
                        ? input.kind === 'command'
                          ? 'Copy full command'
                          : 'Copy input'
                        : 'Copy retained input'
                    }
                  />
                </li>
              ))}
            </ol>
            {execution.omittedInputs > 0 && (
              <p className="execution-note">
                <Info size={12} aria-hidden="true" />
                {execution.omittedInputs} more inputs were not retained.
              </p>
            )}
          </section>
          <section
            className="execution-output"
            aria-label="Output"
            data-output-owner={item.id}
            data-capture={output.capture}
            data-wrap={wrap ? 'true' : 'false'}
          >
            <div className="execution-section-heading">
              <span>
                Output
                {output.capture === 'truncated' && (
                  <span className="execution-retention-tag">Truncated</span>
                )}
              </span>
              {output.text && (
                <span className="execution-actions">
                  <button
                    data-pressable
                    type="button"
                    className="execution-action"
                    aria-pressed={wrap}
                    onClick={() => setWrap(!wrap)}
                  >
                    <WrapText size={12} aria-hidden="true" />
                    Wrap
                  </button>
                  <ExecutionCopyButton text={output.text} label="Copy retained output" />
                </span>
              )}
            </div>
            {output.text ? (
              <ExecutionOutputText text={outputText ?? ''} id={`${id}-output`} />
            ) : (
              <p className="execution-empty-output">
                {output.capture === 'complete' && output.text === ''
                  ? 'No output was returned.'
                  : (output.note ?? 'The transcript does not include captured output.')}
              </p>
            )}
            {longOutput && (
              <button
                data-pressable
                type="button"
                className="execution-more"
                aria-controls={`${id}-output`}
                onClick={() => setShowAll(!showAll)}
                aria-expanded={showAll}
              >
                <span>
                  {showAll
                    ? `${output.lines} retained lines`
                    : `Showing ${previewLines} of ${output.lines} retained lines`}
                </span>
                <span>
                  {showAll ? 'Show less' : 'Show retained text'}
                  <ChevronRight size={11} aria-hidden="true" />
                </span>
              </button>
            )}
            {output.text && output.note && (
              <p className="execution-note">
                <Info size={12} aria-hidden="true" />
                <span>{output.note}</span>
              </p>
            )}
          </section>
          {(execution.exitCode !== undefined || item.toolEffects?.length) && (
            <div className="execution-observations">
              {execution.exitCode !== undefined && (
                <span className="execution-exit-code">Exit {execution.exitCode}</span>
              )}
              <ToolEffectNotes effects={item.toolEffects} />
            </div>
          )}
          {edit && <ToolEditDiff edit={edit} />}
        </div>
      )}
    </div>
  )
}

function ExecutionLiveDuration({ since }: { since: string | undefined }) {
  const start = since ? Date.parse(since) : Number.NaN
  const known = Number.isFinite(start)
  const now = useAgeNow(start, 0, known)
  return known ? (
    <span className="execution-duration work-line-time">
      {formatWorkDuration(Math.max(0, now - start))}
    </span>
  ) : null
}
