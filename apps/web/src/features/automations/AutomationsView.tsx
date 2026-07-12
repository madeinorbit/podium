import {
  Bell,
  BrushCleaning,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  GitMerge,
  LoaderCircle,
  MessageSquareWarning,
  Plus,
  RotateCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/** A durable event subscription row, inferred from the tRPC contract so the UI
 *  tracks the server's `Subscription` shape without re-declaring it. */
type Subscription = Awaited<ReturnType<Trpc['issues']['subscriptionList']['query']>>[number]

type TriggerKind = 'schedule' | 'reactive'

interface Automation {
  id: string
  name: string
  icon: ReactNode
  trigger: TriggerKind
  /** Human-readable trigger summary, e.g. "Weekly on Sunday at 04:00". */
  summary: string
  enabled: boolean
  /** Small muted "agent · model" line on the card, if configured. */
  agentLine?: string
}

type RunStatus = 'success' | 'failure' | 'running'

interface AutomationRun {
  id: string
  status: RunStatus
  /** Relative time, e.g. "2h ago". */
  when: string
  /** Duration, e.g. "1m 12s" — empty while running. */
  duration: string
  summary: string
}

/** Hardcoded mock run history for the prototype, keyed by automation id. */
const MOCK_RUNS: Record<string, AutomationRun[]> = {
  'seed-worktree-cleanup': [
    {
      id: 'r1',
      status: 'running',
      when: 'now',
      duration: '',
      summary: 'Scanning worktrees…',
    },
    {
      id: 'r2',
      status: 'success',
      when: '2h ago',
      duration: '1m 12s',
      summary: 'Pruned 3 worktrees',
    },
    {
      id: 'r3',
      status: 'success',
      when: 'yesterday',
      duration: '48s',
      summary: 'No changes needed',
    },
  ],
  'seed-changelog-update': [
    {
      id: 'r1',
      status: 'success',
      when: '5h ago',
      duration: '2m 04s',
      summary: 'Appended entry for #94 merge',
    },
    {
      id: 'r2',
      status: 'failure',
      when: 'yesterday',
      duration: '31s',
      summary: 'Rebase conflict in CHANGELOG.md',
    },
  ],
}

/** Seeded example automations — all deactivated; this view is a prototype. */
const SEED_AUTOMATIONS: Automation[] = [
  {
    id: 'seed-worktree-cleanup',
    name: 'Worktree cleanup',
    icon: <BrushCleaning size={16} aria-hidden="true" />,
    trigger: 'schedule',
    summary: 'Weekly on Sunday at 04:00 — prune merged/stale worktrees',
    enabled: false,
  },
  {
    id: 'seed-changelog-update',
    name: 'Changelog update',
    icon: <GitMerge size={16} aria-hidden="true" />,
    trigger: 'reactive',
    summary: 'On merge to main — append changelog entry',
    enabled: false,
  },
  {
    id: 'seed-stale-issue-nudge',
    name: 'Stale issue nudge',
    icon: <MessageSquareWarning size={16} aria-hidden="true" />,
    trigger: 'schedule',
    summary: 'Daily at 09:00',
    enabled: false,
  },
  {
    id: 'seed-dependency-audit',
    name: 'Dependency audit',
    icon: <ShieldCheck size={16} aria-hidden="true" />,
    trigger: 'schedule',
    summary: 'Weekly on Monday at 06:00',
    enabled: false,
  },
]

type Frequency = 'hourly' | 'daily' | 'weekly' | 'cron'
type ReactiveTrigger = 'merge-main' | 'new-issue' | 'worktree-idle' | 'file-changed'

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const REACTIVE_LABELS: Record<ReactiveTrigger, string> = {
  'merge-main': 'Branch merged to main',
  'new-issue': 'New issue created',
  'worktree-idle': 'Worktree goes idle',
  'file-changed': 'File changed',
}

/** Build a cron expression from the schedule form fields. */
function cronPreview(freq: Frequency, time: string, weekday: number, rawCron: string): string {
  if (freq === 'cron') return rawCron || '* * * * *'
  if (freq === 'hourly') return '0 * * * *'
  const [hRaw, mRaw] = time.split(':')
  const h = String(Number(hRaw ?? 0) || 0)
  const m = String(Number(mRaw ?? 0) || 0)
  if (freq === 'daily') return `${m} ${h} * * *`
  return `${m} ${h} * * ${weekday}`
}

/** Human summary for a schedule automation from the form fields. */
function scheduleSummary(freq: Frequency, time: string, weekday: number, rawCron: string): string {
  switch (freq) {
    case 'hourly':
      return 'Hourly, on the hour'
    case 'daily':
      return `Daily at ${time}`
    case 'weekly':
      return `Weekly on ${WEEKDAYS[weekday]} at ${time}`
    case 'cron':
      return `Cron: ${rawCron || '(unset)'}`
  }
}

/**
 * The Automations surface — a clickable PROTOTYPE only. Local state, no
 * backend: seeded example automations with working enable toggles, and a
 * "New automation" composer that appends to the local list.
 */
export function AutomationsView(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [automations, setAutomations] = useState<Automation[]>(SEED_AUTOMATIONS)
  const [creating, setCreating] = useState(false)

  const toggle = (id: string, enabled: boolean): void =>
    setAutomations((list) => list.map((a) => (a.id === id ? { ...a, enabled } : a)))

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Automations">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <div className="min-w-0">
          <h2 className="font-medium text-base text-foreground">Automations</h2>
          <p className="truncate text-[12px] text-muted-foreground">
            Notification triggers and recurring agent tasks for your repos.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New automation
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <TriggersSection trpc={trpc} />

          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h3 className="font-medium text-[13px] text-foreground">Scheduled &amp; reactive</h3>
              <p className="text-[12px] text-muted-foreground">
                Recurring and event-reactive agent tasks. Prototype — not yet wired to a runner.
              </p>
            </div>
            {automations.map((a) => (
              <AutomationCard key={a.id} automation={a} onToggle={(v) => toggle(a.id, v)} />
            ))}
          </div>
        </div>
      </div>

      {creating && (
        <NewAutomationDialog
          onClose={() => setCreating(false)}
          onCreate={(a) => {
            setAutomations((list) => [...list, a])
            setCreating(false)
          }}
        />
      )}
    </section>
  )
}

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
 *  read-only so operators know they exist; toggling them is not yet supported. */
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
function TriggersSection({ trpc }: { trpc: Trpc }): JSX.Element {
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

function AutomationCard({
  automation,
  onToggle,
}: {
  automation: Automation
  onToggle: (enabled: boolean) => void
}): JSX.Element {
  const a = automation
  const [expanded, setExpanded] = useState(false)
  const runs = MOCK_RUNS[a.id] ?? []
  const lastRun = runs.find((r) => r.status !== 'running')
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-card transition-colors',
        !a.enabled && 'opacity-80',
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          className="-ml-1 flex size-6 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${a.name} runs`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
        </button>
        <span
          className={cn(
            'flex size-8 flex-none items-center justify-center rounded-md bg-muted/60',
            a.enabled ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {a.icon}
        </span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: convenience click target; the chevron button is the accessible control */}
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-[13px] text-foreground">{a.name}</span>
            <Badge variant="outline" className="font-normal">
              {a.trigger === 'schedule' ? 'Schedule' : 'Reactive'}
            </Badge>
          </div>
          <div className="truncate text-[12px] text-muted-foreground">{a.summary}</div>
          <div className="truncate text-[11px] text-muted-foreground/70">
            Last run: {lastRun ? `${lastRun.when} — ${lastRun.summary}` : '—'}
            {a.agentLine ? ` · ${a.agentLine}` : ''}
          </div>
        </div>
        <Switch
          checked={a.enabled}
          onCheckedChange={onToggle}
          aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
        />
      </div>
      {expanded && (
        <div className="border-border border-t px-3 py-2">
          <div className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Recent runs
          </div>
          {runs.length === 0 ? (
            <div className="py-1 text-[12px] text-muted-foreground/70">No runs yet</div>
          ) : (
            <ul className="flex flex-col">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2 py-1 text-[12px]">
                  <RunStatusIcon status={r.status} />
                  <span className="w-16 flex-none text-muted-foreground">{r.when}</span>
                  <span className="w-14 flex-none text-muted-foreground/70">
                    {r.duration || '—'}
                  </span>
                  <span className="min-w-0 truncate text-foreground">{r.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function RunStatusIcon({ status }: { status: RunStatus }): JSX.Element {
  if (status === 'success')
    return <CircleCheck size={14} aria-label="Succeeded" className="flex-none text-success" />
  if (status === 'failure')
    return <CircleX size={14} aria-label="Failed" className="flex-none text-red-500" />
  return (
    <LoaderCircle
      size={14}
      aria-label="Running"
      className="flex-none animate-spin text-muted-foreground"
    />
  )
}

/**
 * The "New automation" composer — local-only. Create appends a deactivated
 * automation to the caller's list and closes.
 */
function NewAutomationDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (a: Automation) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TriggerKind>('schedule')
  // Schedule fields.
  const [freq, setFreq] = useState<Frequency>('daily')
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState(1) // Monday
  const [rawCron, setRawCron] = useState('')
  // Reactive fields.
  const [reactive, setReactive] = useState<ReactiveTrigger>('merge-main')
  const [glob, setGlob] = useState('')
  // Task prompt.
  const [prompt, setPrompt] = useState('')
  // Runner configuration (local-only mock).
  const [agent, setAgent] = useState('Claude Code')
  const [model, setModel] = useState('Fable 5')
  const [thinking, setThinking] = useState('Medium')

  const cron = cronPreview(freq, time, weekday, rawCron)
  const canCreate = name.trim().length > 0

  const create = (): void => {
    if (!canCreate) return
    const summary =
      kind === 'schedule'
        ? scheduleSummary(freq, time, weekday, rawCron)
        : reactive === 'file-changed' && glob.trim()
          ? `${REACTIVE_LABELS[reactive]} — ${glob.trim()}`
          : REACTIVE_LABELS[reactive]
    onCreate({
      id: `local-${Date.now()}`,
      name: name.trim(),
      icon: <RotateCw size={16} aria-hidden="true" />,
      trigger: kind,
      summary,
      enabled: false,
      agentLine: `${agent} · ${model}`,
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
          <DialogTitle>New automation</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nightly test sweep"
            />
          </div>

          <Tabs value={kind} onValueChange={(v) => setKind(v as TriggerKind)}>
            <TabsList className="w-full">
              <TabsTrigger value="schedule" className="flex-1">
                Schedule
              </TabsTrigger>
              <TabsTrigger value="reactive" className="flex-1">
                Reactive loop
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {kind === 'schedule' ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Frequency</Label>
                <Select value={freq} onValueChange={(v) => setFreq(v as Frequency)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="cron">Custom cron</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {freq === 'weekly' && (
                <div className="flex flex-col gap-1.5">
                  <Label>Day of week</Label>
                  <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(freq === 'daily' || freq === 'weekly') && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="automation-time">Time</Label>
                  <Input
                    id="automation-time"
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-32"
                  />
                </div>
              )}
              {freq === 'cron' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="automation-cron">Cron expression</Label>
                  <Input
                    id="automation-cron"
                    value={rawCron}
                    onChange={(e) => setRawCron(e.target.value)}
                    placeholder="*/30 * * * *"
                    className="font-mono"
                  />
                </div>
              )}
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                <span className="text-[11px] text-muted-foreground">cron</span>
                <code className="font-mono text-[12px] text-foreground">{cron}</code>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Trigger</Label>
                <Select value={reactive} onValueChange={(v) => setReactive(v as ReactiveTrigger)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(REACTIVE_LABELS) as ReactiveTrigger[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {REACTIVE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {reactive === 'file-changed' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="automation-glob">Path glob</Label>
                  <Input
                    id="automation-glob"
                    value={glob}
                    onChange={(e) => setGlob(e.target.value)}
                    placeholder="src/**/*.ts"
                    className="font-mono"
                  />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-prompt">Task prompt</Label>
            <Textarea
              id="automation-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do each run?"
              className="min-h-24"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="automation-agent">Agent</Label>
              <Select value={agent} onValueChange={(v) => setAgent(v ?? 'Claude Code')}>
                <SelectTrigger id="automation-agent" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['Claude Code', 'Codex', 'Shell command'].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="automation-model">Model</Label>
              <Select value={model} onValueChange={(v) => setModel(v ?? 'Fable 5')}>
                <SelectTrigger id="automation-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5'].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="automation-thinking">Thinking</Label>
              <Select value={thinking} onValueChange={(v) => setThinking(v ?? 'Medium')}>
                <SelectTrigger id="automation-thinking" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['Low', 'Medium', 'High', 'Max'].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canCreate} onClick={create}>
            Create automation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
