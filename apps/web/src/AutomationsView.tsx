import {
  BrushCleaning,
  GitMerge,
  MessageSquareWarning,
  Plus,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
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

type TriggerKind = 'schedule' | 'reactive'

interface Automation {
  id: string
  name: string
  icon: ReactNode
  trigger: TriggerKind
  /** Human-readable trigger summary, e.g. "Weekly on Sunday at 04:00". */
  summary: string
  enabled: boolean
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
            Recurring and reactive agent tasks that run on your repos.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New automation
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {automations.map((a) => (
            <AutomationCard key={a.id} automation={a} onToggle={(v) => toggle(a.id, v)} />
          ))}
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

function AutomationCard({
  automation,
  onToggle,
}: {
  automation: Automation
  onToggle: (enabled: boolean) => void
}): JSX.Element {
  const a = automation
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 transition-colors',
        !a.enabled && 'opacity-80',
      )}
    >
      <span
        className={cn(
          'flex size-8 flex-none items-center justify-center rounded-md bg-muted/60',
          a.enabled ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {a.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[13px] text-foreground">{a.name}</span>
          <Badge variant="outline" className="font-normal">
            {a.trigger === 'schedule' ? 'Schedule' : 'Reactive'}
          </Badge>
        </div>
        <div className="truncate text-[12px] text-muted-foreground">{a.summary}</div>
        <div className="text-[11px] text-muted-foreground/70">Last run: —</div>
      </div>
      <Switch
        checked={a.enabled}
        onCheckedChange={onToggle}
        aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
      />
    </div>
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
      icon: <Zap size={16} aria-hidden="true" />,
      trigger: kind,
      summary,
      enabled: false,
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
