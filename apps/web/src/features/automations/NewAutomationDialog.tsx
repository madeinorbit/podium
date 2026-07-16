import { shallowEqual } from '@podium/client-core/store'
import type { AutomationSessionMode } from '@podium/protocol'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
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
import { AUTO } from '@/lib/agent-models'
import { repoUsageAt } from '@/lib/derive'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentLabel,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import type { Automation } from './AutomationsView'
import { cronFromFields, type Frequency, isValidCronExpression, WEEKDAYS } from './cron-format'

type TriggerKind = 'schedule' | 'reactive'
type ReactiveTrigger = 'merge-main' | 'new-issue' | 'worktree-idle' | 'file-changed'

const REACTIVE_LABELS: Record<ReactiveTrigger, string> = {
  'merge-main': 'Branch merged to main',
  'new-issue': 'New task created',
  'worktree-idle': 'Worktree goes idle',
  'file-changed': 'File changed',
}

/** Sentinel for the repo picker's "no repo" option: the automation runs in the home
 *  directory (repo_path NULL server-side) [spec:SP-17db]. */
const GLOBAL_TARGET = '__global__'

const repoLabel = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const localDateTimeValue = (iso?: string | null): string => {
  const fallback = new Date(Date.now() + 60 * 60_000)
  fallback.setSeconds(0, 0)
  const date = iso ? new Date(iso) : fallback
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/**
 * The "New automation" composer (#470) [spec:SP-17db]. Schedule creates a REAL,
 * persisted automation via `automations.create`. Reactive keeps its fields visible
 * — the design intent is real — but Create is disabled and says so: there is no
 * runner behind it yet, and a composer that silently discards its input is exactly
 * what this change removes.
 */
export function NewAutomationDialog({
  trpc,
  automation,
  onClose,
  onSaved,
}: {
  trpc: Trpc
  automation: Automation | null
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { repos, sessions } = useStoreSelector(
    (s) => ({ repos: s.repos, sessions: s.sessions ?? [] }),
    shallowEqual,
  )
  const editing = automation !== null
  const [name, setName] = useState(automation?.name ?? '')
  const [kind, setKind] = useState<TriggerKind>('schedule')
  // Existing recurring schedules open as custom cron so their exact expression is preserved.
  const [freq, setFreq] = useState<Frequency>(
    automation ? (automation.scheduleKind === 'once' ? 'once' : 'cron') : 'daily',
  )
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState(1) // Monday
  const [rawCron, setRawCron] = useState(automation?.cron ?? '')
  const [runAt, setRunAt] = useState(() => localDateTimeValue(automation?.runAt))
  // Reactive fields (composed but not creatable — no runner yet).
  const [reactive, setReactive] = useState<ReactiveTrigger>('merge-main')
  const [glob, setGlob] = useState('')
  // Target: the most-recently-used repo, or Global.
  const [target, setTarget] = useState(() => {
    if (automation) return automation.repoPath ?? GLOBAL_TARGET
    const choices = repos.filter((r) => r.kind !== 'worktree')
    const mru = [...choices].sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))[0]
    return mru?.path ?? GLOBAL_TARGET
  })
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const [agent, setAgent] = useState<IssueAgentKind>(() =>
    issueDefaultAgentKind(automation?.agentKind ?? 'claude-code'),
  )
  const [model, setModel] = useState(automation?.model ?? AUTO)
  const [effort, setEffort] = useState(automation?.effort ?? AUTO)
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [sessionMode, setSessionMode] = useState<AutomationSessionMode>(
    automation?.sessionMode ?? 'fresh',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const repoChoices = repos
    .filter((r) => r.kind !== 'worktree')
    .sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))
  const cron = cronFromFields(freq, time, weekday, rawCron)
  const runAtTimestamp = new Date(runAt).getTime()
  const oneOffRunAt = Number.isFinite(runAtTimestamp)
    ? new Date(runAtTimestamp).toISOString()
    : null
  // The composer's own frequencies always build a valid expression; only the custom
  // cron box can be empty or malformed. Gating Create on validity is what stops an
  // untouched box from arming a schedule (#470) — it no longer falls back to
  // `* * * * *`, which would have spawned an agent session every minute.
  const cronValid = isValidCronExpression(cron)
  const cronInvalid = freq === 'cron' && cron.length > 0 && !cronValid
  const scheduleValid = freq === 'once' ? runAtTimestamp > Date.now() : cronValid
  const canSave =
    kind === 'schedule' &&
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    scheduleValid &&
    !saving

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    setError('')
    const input = {
      name: name.trim(),
      repoPath: target === GLOBAL_TARGET ? null : target,
      scheduleKind: freq === 'once' ? ('once' as const) : ('cron' as const),
      cron: freq === 'once' ? null : cron,
      runAt: freq === 'once' ? oneOffRunAt : null,
      // Agent-created targeted one-offs keep their explicit session when edited.
      targetSessionId: automation?.targetSessionId ?? null,
      agentKind: agent,
      model,
      effort,
      prompt: prompt.trim(),
      enabled,
      sessionMode,
    }
    const request = automation
      ? trpc.automations.update.mutate({ id: automation.id, patch: input })
      : trpc.automations.create.mutate(input)
    request
      .then(() => onSaved())
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
          <DialogTitle>{editing ? 'Edit automation' : 'New automation'}</DialogTitle>
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
                    <SelectItem value="once">One time</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="cron">Custom cron</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {freq === 'once' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="automation-run-at">Run at</Label>
                  <Input
                    id="automation-run-at"
                    type="datetime-local"
                    value={runAt}
                    onChange={(event) => setRunAt(event.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {scheduleValid
                      ? 'This automation will run once, at this local date and time.'
                      : 'Choose a date and time in the future.'}
                  </span>
                </div>
              )}

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
                    aria-invalid={cronInvalid}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {cronInvalid
                      ? 'Not a valid cron expression — 5 fields: minute hour day month weekday.'
                      : 'Five fields: minute hour day month weekday. Minimum interval: one minute.'}
                  </span>
                </div>
              )}
              {freq === 'once' ? (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                  <span className="text-[11px] text-muted-foreground">one time</span>
                  <span className="text-[12px] text-foreground">
                    {oneOffRunAt ? new Date(oneOffRunAt).toLocaleString() : '—'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                  <span className="text-[11px] text-muted-foreground">cron</span>
                  <code className="font-mono text-[12px] text-foreground">{cron || '—'}</code>
                  <span className="text-[11px] text-muted-foreground/70">server-local time</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
                Reactive automations are not yet wired to a runner — this shape is design only, and
                Create stays disabled. Scheduled automations are real.
              </div>
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
            <Label htmlFor="automation-target">Target</Label>
            <Select value={target} onValueChange={(v) => setTarget(v ?? GLOBAL_TARGET)}>
              <SelectTrigger id="automation-target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repoChoices.map((r) => (
                  <SelectItem key={r.path} value={r.path}>
                    {repoLabel(r.path)}
                  </SelectItem>
                ))}
                <SelectItem value={GLOBAL_TARGET}>Global (home directory)</SelectItem>
              </SelectContent>
            </Select>
            {automation?.targetSessionId && (
              <span className="text-[11px] text-muted-foreground">
                Explicit session target: {automation.targetSessionId}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-session-mode">Session mode</Label>
            <Select
              value={sessionMode}
              onValueChange={(value) => setSessionMode(value as AutomationSessionMode)}
            >
              <SelectTrigger id="automation-session-mode" className="w-full">
                <SelectValue>
                  {sessionMode === 'resume'
                    ? 'Resume the previous session'
                    : 'Fresh task and session each run'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fresh">Fresh task and session each run</SelectItem>
                <SelectItem value="resume">Resume the previous session</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              Resume falls back to a fresh automation issue if the previous session was deleted or
              never became resumable.
            </span>
          </div>

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

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="automation-agent">Agent</Label>
              <Select
                value={agent}
                onValueChange={(v) => {
                  // Model + effort are scoped to the agent — changing it resets both.
                  setAgent(issueDefaultAgentKind(v))
                  setModel(AUTO)
                  setEffort(AUTO)
                }}
              >
                <SelectTrigger id="automation-agent" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_AGENT_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {issueAgentLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-1.5 pb-0.5">
              <ModelPicker
                agentKind={agent}
                value={model}
                onChange={(m) => {
                  // Effort is per-model — reset it whenever the model changes.
                  setModel(m)
                  setEffort(AUTO)
                }}
              />
              <EffortPicker agentKind={agent} model={model} value={effort} onChange={setEffort} />
            </div>
          </div>

          <Label className="cursor-pointer gap-2 font-normal text-[13px] text-muted-foreground">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            Enabled — start firing on this schedule
          </Label>

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
          <Button type="button" disabled={!canSave} onClick={save}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
