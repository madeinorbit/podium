import {
  formatShippingElapsed,
  shippingActivityLabel,
  shippingPanelModel,
  type ShippingPanelRow,
  type ShippingWaitingLane,
} from '@podium/client-core/viewmodels'
import type { ShipHoldAction, ShipOrderProjection } from '@podium/model'
import { ChevronLeft, Circle, CircleCheck, TriangleAlert } from 'lucide-react'
import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { issueIdTitle, issueRefLabel } from '@/lib/issue-labels'

interface ShippingPanelProps {
  orders: readonly ShipOrderProjection[]
  issues: readonly IssueViewModel[]
  repoId: string | null
  now: number
  onSelectIssue: (issue: IssueViewModel) => void
}

function Section({
  id,
  label,
  count,
  children,
}: {
  id: string
  label: string
  count: number
  children: ReactNode
}): JSX.Element {
  return (
    <section className="border-t border-hairline-soft" aria-labelledby={id}>
      <div className="flex min-h-8 items-center gap-2 px-3.5 py-1.5">
        <h3 id={id} className="font-mono shell-type-micro font-medium tracking-[0.12em] text-label">
          {label}
        </h3>
        <span className="font-mono shell-type-micro tabular-nums text-text-dim">{count}</span>
      </div>
      {children}
    </section>
  )
}

function EmptyLine({ children }: { children: ReactNode }): JSX.Element {
  return <p className="px-3.5 pb-3 text-[11px] leading-4 text-muted-foreground/70">{children}</p>
}

function StateMarker({ state }: { state: ShipOrderProjection['humanState'] }): JSX.Element {
  if (state === 'needs_you') {
    return <TriangleAlert size={14} className="flex-none text-destructive" aria-hidden="true" />
  }
  if (state === 'in_progress') {
    return (
      <span
        className="size-2.5 flex-none rounded-full border-2 border-info bg-info/20"
        aria-hidden="true"
      />
    )
  }
  if (state === 'shipped') {
    return <CircleCheck size={14} className="flex-none text-success" aria-hidden="true" />
  }
  return <Circle size={13} className="flex-none text-text-dim" aria-hidden="true" />
}

function IssueIdentity({ row }: { row: ShippingPanelRow }): JSX.Element {
  if (!row.issue) {
    return (
      <span className="min-w-0">
        <span className="block truncate text-[11.5px] font-medium text-foreground/90">
          Task unavailable
        </span>
        <span className="block truncate font-mono shell-type-micro text-text-dim">
          {row.order.destination}
        </span>
      </span>
    )
  }
  return (
    <span className="min-w-0">
      <span className="block truncate text-[11.5px] font-medium text-foreground/90">
        {row.issue.title}
      </span>
      <span className="block truncate font-mono shell-type-micro text-text-dim">
        {issueRefLabel(row.issue)} → {row.order.destination}
      </span>
    </span>
  )
}

function WaitingState({ row, now }: { row: ShippingPanelRow; now: number }): JSX.Element {
  const rank = row.order.queueRank
  return (
    <span className="ml-auto flex-none text-right font-mono shell-type-micro tabular-nums text-text-dim">
      <span>{rank === 1 ? 'Next' : rank ? `#${rank}` : 'Waiting'} · </span>
      <time dateTime={row.order.queuedAt}>
        waiting {formatShippingElapsed(row.order.queuedAt, now)}
      </time>
    </span>
  )
}

function ShippingRow({
  row,
  now,
  setRef,
  onOpen,
  waitingPosition,
}: {
  row: ShippingPanelRow
  now: number
  setRef: (node: HTMLButtonElement | null) => void
  onOpen: () => void
  waitingPosition?: number
}): JSX.Element {
  const shippedAt = new Date(row.order.stateChangedAt)
  const title = row.issue ? issueIdTitle(row.issue) : row.order.destination
  return (
    <button
      ref={setRef}
      data-pressable
      type="button"
      className="flex min-h-11 w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-border/70 hover:bg-secondary/55 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
      title={title}
      onClick={onOpen}
    >
      {waitingPosition === undefined ? (
        <StateMarker state={row.order.humanState} />
      ) : (
        <>
          <span
            className="flex size-4 flex-none items-center justify-center rounded-full border border-border font-mono text-[8px] tabular-nums text-text-dim"
            aria-hidden="true"
          >
            {row.order.queueRank ?? waitingPosition}
          </span>
          <span className="sr-only">Position {row.order.queueRank ?? waitingPosition}</span>
        </>
      )}
      <IssueIdentity row={row} />
      {row.order.humanState === 'waiting' ? (
        <WaitingState row={row} now={now} />
      ) : (
        <span
          className={`ml-auto max-w-[42%] flex-none text-right text-[10px] leading-3.5 ${
            row.order.humanState === 'needs_you'
              ? 'text-destructive'
              : row.order.humanState === 'shipped'
                ? 'text-success'
                : 'text-info'
          }`}
        >
          {row.order.humanState === 'shipped' && Number.isFinite(shippedAt.getTime())
            ? `Shipped ${shippedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : shippingActivityLabel(row.order.activity)}
        </span>
      )}
    </button>
  )
}

const holdActionLabel = (action: ShipHoldAction): string => {
  if (action === 'retry') return 'Retry shipping'
  if (action === 'return-to-issue') return 'Return to issue'
  if (action === 'open-repair') return 'Open repair'
  return action.slice('policy:'.length).replaceAll('-', ' ')
}

function ProofRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid min-h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2 border-b border-hairline-soft px-3.5 text-[10px]">
      <span className="text-text-dim">{label}</span>
      <span className="truncate text-right font-mono text-muted-foreground">{children}</span>
    </div>
  )
}

function ShipmentDetail({
  row,
  now,
  backRef,
  onBack,
  onSelectIssue,
}: {
  row: ShippingPanelRow
  now: number
  backRef: RefObject<HTMLButtonElement | null>
  onBack: () => void
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  const { order, issue } = row
  const stateLabel =
    order.humanState === 'needs_you'
      ? 'NEEDS YOU'
      : order.humanState === 'in_progress'
        ? 'IN PROGRESS'
        : order.humanState.toUpperCase()
  const ref = issue ? issueRefLabel(issue) : 'SHIPPING'
  const elapsed = formatShippingElapsed(order.queuedAt, now)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-none">
      <button
        ref={backRef}
        data-pressable
        type="button"
        className="flex h-9 items-center gap-1.5 px-3 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/35"
        onClick={onBack}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        All shipping
      </button>
      <section
        className="border-t border-hairline-soft px-3.5 py-3"
        aria-labelledby="shipping-detail-title"
      >
        <span
          className={`font-mono shell-type-micro font-semibold tracking-[0.1em] ${
            order.humanState === 'needs_you' ? 'text-destructive' : 'text-info'
          }`}
        >
          {ref} · {stateLabel}
        </span>
        <h3
          id="shipping-detail-title"
          className="mt-1.5 text-[14px] font-semibold leading-5 text-text-strong"
        >
          {issue?.title ?? 'Shipping order'}
        </h3>
        <p className="mt-1 text-[11px] leading-[1.5] text-muted-foreground">
          {order.humanState === 'waiting'
            ? `This delivery is ordered for ${order.destination}. Podium will start it automatically.`
            : order.humanState === 'needs_you'
              ? (order.hold?.headline ?? 'Podium stopped before an unsafe decision.')
              : order.humanState === 'shipped'
                ? `Delivered to ${order.destination}. The configured destination was verified.`
                : `Podium is ${shippingActivityLabel(order.activity).toLowerCase()}. You can leave this panel.`}
        </p>
        <div className="mt-3 flex items-center gap-2 text-[11px] font-medium">
          <StateMarker state={order.humanState} />
          {order.humanState === 'waiting'
            ? `${order.queueRank === 1 ? 'Next' : order.queueRank ? `#${order.queueRank}` : 'Waiting'} · waiting ${elapsed}`
            : shippingActivityLabel(order.activity)}
        </div>
      </section>

      {order.humanState === 'needs_you' && order.hold ? (
        <section
          className="border-t border-hairline-soft px-3.5 py-3"
          aria-labelledby="shipping-actions-title"
        >
          <h4
            id="shipping-actions-title"
            className="font-mono shell-type-micro font-medium tracking-[0.12em] text-label"
          >
            SAFE CHOICES
          </h4>
          <p className="mt-2 text-[11px] leading-[1.5] text-muted-foreground">
            Podium stopped before making this choice. These actions belong to hold generation{' '}
            {order.hold.generation}.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Available hold actions">
            {order.hold.actions.map((action) => (
              <li
                key={action}
                className="rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1 text-[10px] text-foreground"
              >
                {holdActionLabel(action)}
              </li>
            ))}
          </ul>
          {issue && (
            <button
              data-pressable
              type="button"
              className="mt-3 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              onClick={() => onSelectIssue(issue)}
            >
              Return to issue
            </button>
          )}
        </section>
      ) : order.humanState === 'shipped' ? (
        <section className="border-t border-hairline-soft" aria-labelledby="delivery-receipt-title">
          <h4
            id="delivery-receipt-title"
            className="px-3.5 py-2 font-mono shell-type-micro font-medium tracking-[0.12em] text-label"
          >
            DELIVERY RECEIPT
          </h4>
          <ProofRow label="Receipt">{order.receiptId ?? 'Unavailable'}</ProofRow>
          <ProofRow label="Destination">{order.destination}</ProofRow>
          <ProofRow label="Branch">{order.targetBranch}</ProofRow>
          <ProofRow label="Verified">{new Date(order.stateChangedAt).toLocaleString()}</ProofRow>
          <p className="px-3.5 py-3 text-[10.5px] leading-[1.5] text-muted-foreground/75">
            This receipt belongs to this shipment and remains available with the task history.
          </p>
        </section>
      ) : (
        <>
          <section className="border-t border-hairline-soft" aria-labelledby="shipping-proof-title">
            <h4
              id="shipping-proof-title"
              className="px-3.5 py-2 font-mono shell-type-micro font-medium tracking-[0.12em] text-label"
            >
              PROOF SO FAR
            </h4>
            <ProofRow label="Accepted">{new Date(order.queuedAt).toLocaleString()}</ProofRow>
            <ProofRow label="Current">{shippingActivityLabel(order.activity)}</ProofRow>
            <ProofRow label="Destination">{order.destination}</ProofRow>
          </section>
          <details className="group border-t border-hairline-soft px-3.5 py-2.5 text-[10.5px] text-muted-foreground">
            <summary className="cursor-pointer text-[11px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35">
              Technical details
            </summary>
            <dl className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono">
              <dt className="text-text-dim">Order</dt>
              <dd className="truncate text-right">{order.id}</dd>
              <dt className="text-text-dim">Target</dt>
              <dd className="truncate text-right">{order.targetBranch}</dd>
              <dt className="text-text-dim">Changed</dt>
              <dd className="truncate text-right">{order.stateChangedAt}</dd>
            </dl>
          </details>
        </>
      )}
    </div>
  )
}

function WaitingLane({
  lane,
  now,
  rowRef,
  onOpen,
}: {
  lane: ShippingWaitingLane
  now: number
  rowRef: (id: string, node: HTMLButtonElement | null) => void
  onOpen: (row: ShippingPanelRow) => void
}): JSX.Element {
  const id = `shipping-waiting-${lane.destination.replace(/[^a-z0-9]+/gi, '-')}`
  return (
    <Section id={id} label={`WAITING · ${lane.destination}`} count={lane.rows.length}>
      <ol className="px-2.5 pb-2.5">
        {lane.rows.map((row) => (
          <li key={row.order.id}>
            <ShippingRow
              row={row}
              now={now}
              waitingPosition={row.order.queueRank}
              setRef={(node) => rowRef(row.order.id, node)}
              onOpen={() => onOpen(row)}
            />
          </li>
        ))}
      </ol>
    </Section>
  )
}

export function ShippingPanel({
  orders,
  issues,
  repoId,
  now,
  onSelectIssue,
}: ShippingPanelProps): JSX.Element {
  const model = useMemo(() => shippingPanelModel(orders, issues, repoId), [issues, orders, repoId])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const allRows = [
    ...model.needsYou,
    ...model.inProgress,
    ...model.waiting.flatMap((lane) => lane.rows),
    ...model.recentlyShipped,
  ]
  const selected = allRows.find((row) => row.order.id === selectedId)

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null)
  }, [selected, selectedId])
  useEffect(() => {
    if (selected) backRef.current?.focus()
  }, [selected])
  useEffect(() => {
    if (!selected && returnFocusId) {
      rowRefs.current.get(returnFocusId)?.focus()
      setReturnFocusId(null)
    }
  }, [returnFocusId, selected])

  const setRowRef = (id: string, node: HTMLButtonElement | null): void => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }
  const open = (row: ShippingPanelRow): void => setSelectedId(row.order.id)

  if (!repoId) {
    return <div className="p-3 text-xs text-muted-foreground/70">No active repository.</div>
  }
  if (selected) {
    return (
      <ShipmentDetail
        row={selected}
        now={now}
        backRef={backRef}
        onBack={() => {
          setReturnFocusId(selected.order.id)
          setSelectedId(null)
        }}
        onSelectIssue={onSelectIssue}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-none" aria-label="Shipping overview">
      <div className="px-3.5 py-3">
        <strong className="block text-[12px] font-semibold text-text-strong">
          {model.decisionCount > 0 ? 'A shipment needs your decision' : 'Everything is handled'}
        </strong>
        <p className="mt-1 text-[10.5px] leading-[1.5] text-muted-foreground">
          {model.decisionCount > 0
            ? 'Independent deliveries can keep moving.'
            : 'Podium will keep going and alert you only if it cannot finish safely.'}
        </p>
      </div>

      {model.needsYou.length > 0 && (
        <Section id="shipping-needs-you" label="NEEDS YOU" count={model.needsYou.length}>
          <ul className="px-2.5 pb-2.5">
            {model.needsYou.map((row) => (
              <li key={row.order.id}>
                <ShippingRow
                  row={row}
                  now={now}
                  setRef={(node) => setRowRef(row.order.id, node)}
                  onOpen={() => open(row)}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section id="shipping-in-progress" label="IN PROGRESS" count={model.inProgress.length}>
        {model.inProgress.length === 0 ? (
          <EmptyLine>Nothing is shipping right now.</EmptyLine>
        ) : (
          <ul className="px-2.5 pb-2.5">
            {model.inProgress.map((row) => (
              <li key={row.order.id}>
                <ShippingRow
                  row={row}
                  now={now}
                  setRef={(node) => setRowRef(row.order.id, node)}
                  onOpen={() => open(row)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {model.waiting.length === 0 ? (
        <Section id="shipping-waiting" label="WAITING" count={0}>
          <EmptyLine>Nothing is waiting.</EmptyLine>
        </Section>
      ) : (
        model.waiting.map((lane) => (
          <WaitingLane
            key={`${lane.destination}:${lane.targetBranch}`}
            lane={lane}
            now={now}
            rowRef={setRowRef}
            onOpen={open}
          />
        ))
      )}

      <Section
        id="shipping-recently-shipped"
        label="RECENTLY SHIPPED"
        count={model.recentlyShipped.length}
      >
        {model.recentlyShipped.length === 0 ? (
          <EmptyLine>No verified deliveries yet.</EmptyLine>
        ) : (
          <ul className="px-2.5 pb-2.5">
            {model.recentlyShipped.map((row) => (
              <li key={row.order.id}>
                <ShippingRow
                  row={row}
                  now={now}
                  setRef={(node) => setRowRef(row.order.id, node)}
                  onOpen={() => open(row)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <p className="px-3.5 py-3 text-[10px] leading-[1.5] text-muted-foreground/60">
        Waiting order is scoped by destination. Queues keeps merge, test, and resource lanes.
      </p>
    </div>
  )
}
