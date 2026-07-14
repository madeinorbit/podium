import { Bell, CircleCheck, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** A durable event subscription row, inferred from the tRPC contract so the UI
 *  tracks the server's `Subscription` shape without re-declaring it. */
type Subscription = Awaited<ReturnType<Trpc['issues']['subscriptionList']['query']>>[number]

/** The event-subscription kinds a trigger can match. Mirrors the steward's
 *  subscription-event vocabulary (issue lifecycle + session state). */
const TRIGGER_EVENTS = [
  { value: 'issue.closed', label: 'Issue closed' },
  { value: 'issue.stage_changed:review', label: 'Issue moved to review' },
  { value: 'issue.needs_human', label: 'Issue needs a human' },
  { value: 'session.finished', label: 'Session finished' },
  { value: 'session.errored', label: 'Session errored' },
  { value: 'session.waiting', label: 'Session waiting on input' },
] as const

const EVENT_LABELS: Record<string, string> = Object.fromEntries(
  TRIGGER_EVENTS.map((e) => [e.value, e.label]),
)

/** Relationship source refs — dynamic sets resolved against the subscriber's own
 *  subtree at match time (no explicit id needed). */
const RELATIONSHIP_REFS = [
  { value: 'my-children', label: 'My children' },
  { value: 'my-subtree', label: 'My subtree' },
] as const

/** The four code-defined default subscriptions the steward always applies. Shown
 *  read-only so operators know they exist; toggling them is not yet supported (#169). */
const BUILTIN_DEFAULTS = [
  'Child closed → notify parent',
  'Child moved to review → notify parent',
  'Child needs a human → notify parent',
  'Blocker closed → notify dependent (unblock)',
] as const

/** Human summary for a subscription source. */
function sourceSummary(s: Subscription): string {
  if (s.sourceKind === 'relationship') {
    const rel = RELATIONSHIP_REFS.find((r) => r.value === s.sourceRef)
    return rel ? rel.label.toLowerCase() : s.sourceRef
  }
  return `${s.sourceKind} ${s.sourceRef}`
}

/** Human summary for the delivery channels a subscription uses. */
function deliverySummary(s: Subscription): string {
  const parts: string[] = []
  if (s.deliverNudge) parts.push('nudge')
  if (s.deliverNotify) parts.push('notify')
  return parts.length ? parts.join(' + ') : 'no delivery'
}

/** One-line human sentence for a subscription row. */
function subscriptionSentence(s: Subscription): string {
  const event = EVENT_LABELS[s.event] ?? s.event
  return `When ${event.toLowerCase()} from ${sourceSummary(s)}, notify ${s.subscriberKind} ${s.subscriberId} via ${deliverySummary(s)}.`
}

/**
 * The Notification triggers surface — real, backend-wired event subscriptions.
 * Lists live subscriptions (operator sees all), toggles/deletes them, shows the
 * code-defined built-in defaults read-only, and composes new custom triggers.
 */
export function TriggersSection({ trpc }: { trpc: Trpc }): JSX.Element {
  const [subs, setSubs] = useState<Subscription[] | null>(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback((): void => {
    trpc.issues.subscriptionList
      .query()
      .then((rows) => {
        setSubs(rows)
        setError('')
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [trpc])

  useEffect(() => {
    reload()
  }, [reload])

  const setEnabled = (id: string, enabled: boolean): void => {
    setBusyId(id)
    trpc.issues.subscriptionSetEnabled
      .mutate({ id, enabled })
      .then(() => reload())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusyId(null))
  }

  const remove = (id: string): void => {
    setBusyId(id)
    trpc.issues.subscriptionRemove
      .mutate({ id })
      .then(() => reload())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusyId(null))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-col gap-0.5">
          <h3 className="flex items-center gap-1.5 font-medium text-[13px] text-foreground">
            <Bell size={14} aria-hidden="true" /> Notification triggers
          </h3>
          <p className="text-[12px] text-muted-foreground">
            Notify a session or issue when an event fires elsewhere in your tracker.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New trigger
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
          {error}
        </div>
      )}

      {subs === null ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-3 text-[12px] text-muted-foreground">
          <LoaderCircle size={14} aria-hidden="true" className="animate-spin" /> Loading triggers…
        </div>
      ) : subs.length === 0 ? (
        <div className="rounded-md border border-border border-dashed bg-card px-3 py-4 text-center text-[12px] text-muted-foreground">
          No custom triggers yet. The built-in defaults below still apply.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {subs.map((s) => (
            <TriggerRow
              key={s.id}
              sub={s}
              busy={busyId === s.id}
              onToggle={(v) => setEnabled(s.id, v)}
              onRemove={() => remove(s.id)}
            />
          ))}
        </div>
      )}

      <div className="mt-1 rounded-md border border-border bg-muted/40 px-3 py-2.5">
        <div className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Built-in defaults (always on)
        </div>
        <ul className="flex flex-col gap-1">
          {BUILTIN_DEFAULTS.map((d) => (
            <li key={d} className="flex items-center gap-2 text-[12px] text-foreground">
              <CircleCheck size={13} aria-hidden="true" className="flex-none text-success" />
              <span className="min-w-0">{d}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] text-muted-foreground/70">
          Toggling built-in defaults is coming soon.
        </p>
      </div>

      {creating && (
        <NewTriggerDialog
          trpc={trpc}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            reload()
          }}
        />
      )}
    </div>
  )
}

function TriggerRow({
  sub,
  busy,
  onToggle,
  onRemove,
}: {
  sub: Subscription
  busy: boolean
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 transition-colors',
        !sub.enabled && 'opacity-70',
      )}
    >
      <span className="flex size-8 flex-none items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
        <Bell size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] text-foreground">{subscriptionSentence(sub)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <Badge variant="outline" className="font-normal capitalize">
            {sub.origin}
          </Badge>
          <span className="truncate text-[11px] text-muted-foreground/70">{sub.event}</span>
        </div>
      </div>
      <Switch
        checked={sub.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`${sub.enabled ? 'Disable' : 'Enable'} this trigger`}
      />
      <button
        type="button"
        className="flex size-7 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-red-500 disabled:opacity-50"
        aria-label="Delete trigger"
        disabled={busy}
        onClick={onRemove}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

type SourceKind = 'relationship' | 'issue' | 'session'
type SubscriberKind = 'issue' | 'session'

/**
 * The "New trigger" composer — creates a real custom subscription via
 * `subscriptionAdd`. As the operator UI it always sends an explicit subscriber.
 */
function NewTriggerDialog({
  trpc,
  onClose,
  onCreated,
}: {
  trpc: Trpc
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const [event, setEvent] = useState<string>(TRIGGER_EVENTS[0].value)
  const [sourceKind, setSourceKind] = useState<SourceKind>('relationship')
  const [relRef, setRelRef] = useState<string>(RELATIONSHIP_REFS[0].value)
  const [sourceRef, setSourceRef] = useState('')
  const [subscriberKind, setSubscriberKind] = useState<SubscriberKind>('issue')
  const [subscriberId, setSubscriberId] = useState('')
  const [nudge, setNudge] = useState(true)
  const [notify, setNotify] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const ref = sourceKind === 'relationship' ? relRef : sourceRef.trim()
  const canCreate = ref.length > 0 && subscriberId.trim().length > 0 && !saving

  const create = (): void => {
    if (!canCreate) return
    setSaving(true)
    setError('')
    trpc.issues.subscriptionAdd
      .mutate({
        event,
        source: { kind: sourceKind, ref },
        subscriber: { kind: subscriberKind, id: subscriberId.trim() },
        deliver: { nudge, notify },
      })
      .then(() => onCreated())
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        setSaving(false)
      })
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-lg flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New trigger</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Event</Label>
            <Select value={event} onValueChange={(v) => setEvent(v ?? TRIGGER_EVENTS[0].value)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_EVENTS.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Source</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={sourceKind}
                onValueChange={(v) => setSourceKind((v ?? 'relationship') as SourceKind)}
              >
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relationship">Relationship</SelectItem>
                  <SelectItem value="issue">Issue</SelectItem>
                  <SelectItem value="session">Session</SelectItem>
                </SelectContent>
              </Select>
              {sourceKind === 'relationship' ? (
                <Select
                  value={relRef}
                  onValueChange={(v) => setRelRef(v ?? RELATIONSHIP_REFS[0].value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELATIONSHIP_REFS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  placeholder={sourceKind === 'issue' ? 'issue id or #seq' : 'session id'}
                  className="w-full font-mono"
                  aria-label="Source reference"
                />
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="trigger-subscriber-id">Notify (issue/session id)</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={subscriberKind}
                onValueChange={(v) => setSubscriberKind((v ?? 'issue') as SubscriberKind)}
              >
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="issue">Issue</SelectItem>
                  <SelectItem value="session">Session</SelectItem>
                </SelectContent>
              </Select>
              <Input
                id="trigger-subscriber-id"
                value={subscriberId}
                onChange={(e) => setSubscriberId(e.target.value)}
                placeholder={subscriberKind === 'issue' ? 'issue id or #seq' : 'session id'}
                className="w-full font-mono"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
            <Label className="text-[11px] text-muted-foreground uppercase tracking-wide">
              Delivery
            </Label>
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[13px] text-foreground">Nudge</div>
                <div className="text-[11px] text-muted-foreground">
                  Wake the notified session with an in-session message.
                </div>
              </div>
              <Switch checked={nudge} onCheckedChange={setNudge} aria-label="Deliver via nudge" />
            </div>
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[13px] text-foreground">Notify</div>
                <div className="text-[11px] text-muted-foreground">
                  Send an external notification (e.g. Telegram).
                </div>
              </div>
              <Switch
                checked={notify}
                onCheckedChange={setNotify}
                aria-label="Deliver via notify"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canCreate} onClick={create}>
            {saving ? 'Creating…' : 'Create trigger'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
