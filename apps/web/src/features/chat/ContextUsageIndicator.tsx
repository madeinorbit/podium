import { Popover } from '@base-ui/react/popover'
import { useRequestClient } from '@podium/client-core/react'
import { ContextDetailView } from '@podium/client-graph/context-detail'
import type { SessionModel } from '@podium/client-graph/models'
import type {
  ContextCapacity,
  ContextComposition,
  ContextCompositionRow,
  ContextLastRequest,
  ContextQuantity,
} from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { useEffect, useId, useRef, useState } from 'react'
import { usePanelVisible } from '@/app/panel-visible'
import type { Trpc } from '@/app/trpc'
import { MENU_HOVER_CARD } from '@/lib/menu-surface'
import { cn } from '@/lib/utils'

const numbers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 })
const measuredTime = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})
const capacityBasis: Record<ContextCapacity['basis'], string> = {
  native: 'Native context window',
  configured: 'Configured context window',
  'model-metadata': 'Model context window',
  fallback: 'Fallback context window',
}
const stateLabel = {
  available: 'Current measurement',
  stale: 'Stale measurement',
  pending: 'Waiting for measurement',
  unavailable: 'Measurement unavailable',
  unsupported: 'Context unsupported',
  unknown: 'Context not reported',
}

function quantityText(value: ContextQuantity | undefined, suffix = ''): string {
  return value === undefined
    ? 'Unknown'
    : `${numbers.format(value.value)}${suffix} (${value.accuracy})`
}

/** Reads the shared model late. Hidden/warm panels own no detail request. */
export function ContextUsageIndicator({
  session,
  active = true,
}: {
  session: SessionModel | undefined
  active?: boolean
}) {
  const visible = usePanelVisible()
  return session && active && visible ? <ContextCircle key={session.id} session={session} /> : null
}

const ContextCircle = observer(function ContextCircle({ session }: { session: SessionModel }) {
  const [open, setOpen] = useState(false)
  const triggerId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const dismissedFocus = useRef(false)
  const pointerFocus = useRef(false)
  const returnFocus = useRef(false)
  const changeOpen = (next: boolean, details?: Popover.Root.ChangeEventDetails) => {
    if (
      !next &&
      details?.reason === 'trigger-hover' &&
      (trigger.current === document.activeElement ||
        popup.current?.contains(document.activeElement))
    ) {
      details.cancel()
      return
    }
    if (!next) {
      const explicit =
        details?.reason === 'escape-key' ||
        details?.reason === 'close-press' ||
        details?.reason === 'trigger-press'
      returnFocus.current = explicit && (popup.current?.contains(document.activeElement) ?? false)
      dismissedFocus.current =
        explicit && (trigger.current === document.activeElement || returnFocus.current)
    }
    setOpen(next)
  }

  useEffect(() => {
    if (!open) return
    // Hover leaves the caret in the textarea. Consume Escape before composer
    // and global bubble handlers can treat it as a cancel-run shortcut.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      returnFocus.current = popup.current?.contains(document.activeElement) ?? false
      dismissedFocus.current = trigger.current === document.activeElement || returnFocus.current
      setOpen(false)
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [open])

  const occupancy = session.contextOccupancy
  const percent = session.contextPercent
  const over = percent !== undefined && percent > 100
  // A count or reported percentage alone never invents a denominator. Only
  // the drawing uses the model's bounded ratio; text retains the full value.
  const ratio = session.contextCapacity === undefined ? undefined : session.contextRatio
  const measured = session.contextState === 'available' || session.contextState === 'stale'
  const mark =
    session.contextState === 'stale' || over
      ? '!'
      : session.contextState === 'pending'
        ? '…'
        : measured && ratio === undefined
          ? '?'
          : measured
            ? ''
            : '—'
  const label = [
    'Context usage',
    stateLabel[session.contextState],
    occupancy?.usedTokens && `${quantityText(occupancy.usedTokens)} tokens used`,
    session.contextCapacity && `${quantityText(session.contextCapacity)} tokens available`,
    percent !== undefined &&
      `${numbers.format(percent)}%${occupancy?.percent ? ` (${occupancy.percent.accuracy})` : ' (reported)'}`,
    occupancy?.remainingTokens && `${quantityText(occupancy.remainingTokens)} tokens remaining`,
    !session.contextCapacity && 'Capacity unknown',
    over && 'Over capacity',
    session.contextReason?.message,
  ]
    .filter(Boolean)
    .join('. ')

  return (
    <Popover.Root open={open} onOpenChange={changeOpen} triggerId={triggerId} modal={false}>
      <Popover.Trigger
        id={triggerId}
        ref={trigger}
        type="button"
        openOnHover
        delay={180}
        closeDelay={120}
        data-testid="context-usage"
        data-state={session.contextState}
        data-determinate={ratio !== undefined}
        aria-label={label}
        className={cn(
          'relative inline-flex size-7 shrink-0 items-center justify-center rounded-[7px]',
          'text-text-dim hover:bg-hairline-soft hover:text-text-strong',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        )}
        onPointerDown={() => {
          pointerFocus.current = true
        }}
        onFocus={() => {
          if (!pointerFocus.current && !dismissedFocus.current) changeOpen(true)
          pointerFocus.current = false
        }}
        onBlur={() => {
          dismissedFocus.current = false
          pointerFocus.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".2" />
          <circle
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={ratio === undefined ? '3 5' : `${ratio * 100} 100`}
            transform="rotate(-90 12 12)"
            opacity={session.contextState === 'stale' ? '.55' : undefined}
          />
        </svg>
        {mark && (
          <span aria-hidden="true" className="absolute text-[10px] leading-none">
            {mark}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="isolate z-50"
        >
          <Popover.Popup
            ref={popup}
            data-testid="context-usage-panel"
            initialFocus={false}
            finalFocus={() => (returnFocus.current ? trigger.current : false)}
            className={cn(
              MENU_HOVER_CARD,
              'w-[22rem] max-w-[calc(100vw-24px)] max-h-[min(32rem,var(--available-height))]',
              'overflow-y-auto overscroll-contain text-[12px] leading-relaxed outline-none [overflow-wrap:anywhere]',
            )}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <Popover.Title className="font-medium text-text-strong">Context usage</Popover.Title>
              <Popover.Close
                type="button"
                aria-label="Close context usage"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-text-dim hover:bg-hairline-soft focus-visible:outline-2 focus-visible:outline-ring"
              >
                ×
              </Popover.Close>
            </div>
            <ContextSummary session={session} />
            {open && <ContextBreakdown session={session} />}
            <ContextMeasurementDetails session={session} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
})

function Quantity({ value, suffix = '' }: { value: ContextQuantity | undefined; suffix?: string }) {
  return (
    <span className="min-w-0 text-right">
      <span className="font-mono tabular-nums text-text-strong">{quantityText(value, suffix)}</span>
    </span>
  )
}

function Row({
  label,
  value,
  suffix,
}: {
  label: string
  value: ContextQuantity | undefined
  suffix?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-text-dim">{label}</dt>
      <dd className="min-w-0">
        <Quantity value={value} suffix={suffix} />
      </dd>
    </div>
  )
}

const ContextSummary = observer(function ContextSummary({ session }: { session: SessionModel }) {
  const occupancy = session.contextOccupancy
  return (
    <>
      <p className="mb-1 text-text-dim">{stateLabel[session.contextState]}</p>
      {session.contextReason && (
        <p className="mb-2 text-text-dim">{session.contextReason.message}</p>
      )}
      <dl>
        <Row label="Used tokens" value={occupancy?.usedTokens} />
        <Row label="Available context" value={session.contextCapacity} />
        {session.contextCapacityBasis && (
          <div className="mb-1 text-text-faint">
            <dt className="sr-only">Capacity basis</dt>
            <dd>{capacityBasis[session.contextCapacityBasis]}</dd>
          </div>
        )}
        <Row label="Remaining tokens" value={occupancy?.remainingTokens} />
        {session.contextProvenance === 'legacy-percent' && session.contextPercent !== undefined ? (
          <div className="flex justify-between gap-3 py-0.5">
            <dt>Usage</dt>
            <dd>{numbers.format(session.contextPercent)}% (reported)</dd>
          </div>
        ) : (
          <Row label="Usage" value={occupancy?.percent} suffix="%" />
        )}
      </dl>
      {session.contextPercent !== undefined && session.contextPercent > 100 && (
        <p className="mt-1 font-medium text-text-strong">Over capacity</p>
      )}
      {occupancy && (
        <p className="mt-2 text-text-faint">
          {occupancy.basis === 'last-request'
            ? 'Occupancy basis: last request'
            : occupancy.basis === 'native-estimate'
              ? 'Occupancy basis: native estimate'
              : 'Occupancy basis: current context'}
        </p>
      )}
      {session.contextProvenance === 'legacy-percent' && (
        <p className="mt-1 text-text-faint">
          Percentage-only report. Token counts and capacity are unknown.
        </p>
      )}
    </>
  )
})

const ContextMeasurementDetails = observer(function ContextMeasurementDetails({
  session,
}: {
  session: SessionModel
}) {
  const context = session.context
  const known = context?.status === 'unsupported' ? undefined : context
  if (!known || (!known.model && !known.modelCapacity && !known.compaction && !('sample' in known)))
    return null
  return (
    <div className="mt-2 border-t border-hairline-soft pt-2">
      {session.contextObservedModel && (
        <p className="mt-1 text-text-faint">
          Measured model:{' '}
          {[session.contextObservedModel.providerId, session.contextObservedModel.modelId]
            .filter(Boolean)
            .join(' / ')}
        </p>
      )}
      {(context?.status === 'available' || context?.status === 'stale') && (
        <p className="mt-1 text-text-faint">
          Measured{' '}
          <time dateTime={context.sample.at}>
            {measuredTime.format(new Date(context.sample.at))} UTC
          </time>
        </p>
      )}
      {known?.modelCapacity && (
        <dl className="mt-2 border-t border-hairline-soft pt-2">
          <Row label="Model maximum" value={known.modelCapacity} />
        </dl>
      )}
      {known?.compaction && (
        <section className="mt-2 border-t border-hairline-soft pt-2" aria-label="Compaction policy">
          <h3 className="font-medium text-text-strong">Compaction policy</h3>
          <p className="text-text-faint">
            Separate from occupied context · {known.compaction.source}
          </p>
          <dl>
            <div className="flex justify-between gap-3 py-0.5">
              <dt>Auto-compaction</dt>
              <dd>
                {known.compaction.enabled === undefined
                  ? 'Unknown'
                  : known.compaction.enabled
                    ? 'Enabled'
                    : 'Disabled'}
              </dd>
            </div>
            {known.compaction.thresholdTokens && (
              <Row label="Threshold tokens" value={known.compaction.thresholdTokens} />
            )}
            {known.compaction.thresholdPercent && (
              <Row label="Threshold usage" value={known.compaction.thresholdPercent} suffix="%" />
            )}
            {known.compaction.reserveTokens && (
              <Row label="Compaction reserve" value={known.compaction.reserveTokens} />
            )}
          </dl>
        </section>
      )}
    </div>
  )
})

const ContextBreakdown = observer(function ContextBreakdown({
  session,
}: {
  session: SessionModel
}) {
  const api = useRequestClient<Trpc>()
  const [detail] = useState(() => new ContextDetailView(session, api))
  useEffect(() => {
    detail.open()
    void detail.load()
    return () => detail.close()
  }, [detail])
  const answer = detail.answer
  return (
    <section
      className="mt-2 border-t border-hairline-soft pt-2"
      aria-label="Context breakdown"
      aria-busy={detail.loading}
    >
      {detail.loading && <p role="status">Loading breakdown…</p>}
      {detail.error && (
        <>
          <p role="status">{detail.error.message}</p>
          {session.contextDetailLevel === 'on-demand' && (
            <button
              type="button"
              className="mt-1 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => void detail.retry()}
            >
              Retry breakdown
            </button>
          )}
        </>
      )}
      {answer?.status === 'available' && (
        <>
          {answer.composition ? (
            <Composition composition={answer.composition} />
          ) : (
            <p className="text-text-faint">Semantic composition unavailable.</p>
          )}
          {answer.lastRequest && <RequestAccounting request={answer.lastRequest} />}
        </>
      )}
      {!detail.loading &&
        !answer &&
        (session.contextDetailLevel === 'on-demand' ? (
          <>
            <p className="text-text-faint">No breakdown loaded for this measurement.</p>
            <button
              type="button"
              className="mt-1 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => void detail.load()}
            >
              Load current breakdown
            </button>
          </>
        ) : (
          <p className="text-text-faint">No breakdown available for this measurement.</p>
        ))}
    </section>
  )
})

const kindLabel: Record<ContextCompositionRow['kind'], string> = {
  used: 'Occupied content',
  reserve: 'Reserve',
  free: 'Free space',
  excluded: 'Excluded content',
  deferred: 'Deferred content',
}

function Composition({ composition }: { composition: ContextComposition }) {
  return (
    <section aria-label="Semantic composition">
      <h3 className="font-medium text-text-strong">Context composition</h3>
      {composition.usedTokens && (
        <dl>
          <Row label="Composition occupied total" value={composition.usedTokens} />
        </dl>
      )}
      <p className="text-text-faint">
        {composition.coverage === 'complete'
          ? 'Complete attribution'
          : composition.coverage === 'partial'
            ? 'Partial attribution; some content is unattributed'
            : 'Attribution coverage unknown'}
        {composition.truncated && ' · List truncated'}
      </p>
      {(['used', 'reserve', 'free', 'excluded', 'deferred'] as const).map(
        (kind) =>
          composition.rows.some((row) => row.kind === kind) && (
            <div className="mt-2" key={kind}>
              <h4 className="text-text-dim">
                {kindLabel[kind]}
                {kind !== 'used' && ' · outside used total'}
              </h4>
              <CompositionRows composition={composition} kind={kind} />
            </div>
          ),
      )}
    </section>
  )
}

function CompositionRows({
  composition,
  kind,
  parentId,
}: {
  composition: ContextComposition
  kind: ContextCompositionRow['kind']
  parentId?: string
}) {
  return (
    <ul className={parentId ? 'ml-2 border-l border-hairline-soft pl-2' : undefined}>
      {composition.rows
        .filter((row) => row.kind === kind && row.parentId === parentId)
        .map((row) => (
          <li key={row.id}>
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="min-w-0">
                {row.label}
                {row.attribution === 'unattributed' && ' · unattributed'}
              </span>
              <Quantity value={row.tokens} />
            </div>
            {row.childrenCoverage && (
              <>
                <p className="text-[10px] text-text-faint">
                  Within this category · {row.childrenCoverage} attribution
                </p>
                <CompositionRows composition={composition} kind={kind} parentId={row.id} />
              </>
            )}
          </li>
        ))}
    </ul>
  )
}

function RequestAccounting({ request }: { request: ContextLastRequest }) {
  return (
    <section
      className="mt-2 border-t border-hairline-soft pt-2"
      aria-label="Last-request accounting"
    >
      <h3 className="font-medium text-text-strong">Last-request accounting</h3>
      <p className="text-text-faint">
        Cache is included in input; reasoning is included in output. These are request counts, not
        content categories.
      </p>
      {request.model && (
        <p className="text-text-faint">
          Request model:{' '}
          {[request.model.providerId, request.model.modelId].filter(Boolean).join(' / ')}
        </p>
      )}
      <dl>
        <Row label="Input (inclusive)" value={request.input} />
        {request.cacheRead && <Row label="Cache read (input subset)" value={request.cacheRead} />}
        {request.cacheWrite && (
          <Row label="Cache write (input subset)" value={request.cacheWrite} />
        )}
        <Row label="Output (inclusive)" value={request.output} />
        {request.reasoning && <Row label="Reasoning (output subset)" value={request.reasoning} />}
      </dl>
    </section>
  )
}
