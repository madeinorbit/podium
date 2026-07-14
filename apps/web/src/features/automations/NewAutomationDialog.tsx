import { shallowEqual } from '@podium/client-core/store'
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
import { cronFromFields, type Frequency, isValidCronExpression, WEEKDAYS } from './cron-format'

type TriggerKind = 'schedule' | 'reactive'
type ReactiveTrigger = 'merge-main' | 'new-issue' | 'worktree-idle' | 'file-changed'

const REACTIVE_LABELS: Record<ReactiveTrigger, string> = {
  'merge-main': 'Branch merged to main',
  'new-issue': 'New issue created',
  'worktree-idle': 'Worktree goes idle',
  'file-changed': 'File changed',
}

/** Sentinel for the repo picker's "no repo" option: the automation runs in the home
 *  directory (repo_path NULL server-side) [spec:SP-17db]. */
const GLOBAL_TARGET = '__global__'

const repoLabel = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/**
 * The "New automation" composer (#470) [spec:SP-17db]. Schedule creates a REAL,
 * persisted automation via `automations.create`. Reactive keeps its fields visible
 * — the design intent is real — but Create is disabled and says so: there is no
 * runner behind it yet, and a composer that silently discards its input is exactly
 * what this change removes.
 */
export function NewAutomationDialog({
  trpc,
  onClose,
  onCreated,
}: {
  trpc: Trpc
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const { repos, sessions } = useStoreSelector(
    (s) => ({ repos: s.repos, sessions: s.sessions ?? [] }),
    shallowEqual,
  )
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TriggerKind>('schedule')
  // Schedule fields.
  const [freq, setFreq] = useState<Frequency>('daily')
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState(1) // Monday
  const [rawCron, setRawCron] = useState('')
  // Reactive fields (composed but not creatable — no runner yet).
  const [reactive, setReactive] = useState<ReactiveTrigger>('merge-main')
  const [glob, setGlob] = useState('')
  // Target: the most-recently-used repo, or Global.
  const [target, setTarget] = useState(() => {
    const choices = repos.filter((r) => r.kind !== 'worktree')
    const mru = [...choices].sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))[0]
    return mru?.path ?? GLOBAL_TARGET
  })
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState<IssueAgentKind>('claude-code')
  const [model, setModel] = useState(AUTO)
  const [effort, setEffort] = useState(AUTO)
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const repoChoices = repos
    .filter((r) => r.kind !== 'worktree')
    .sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))
  const cron = cronFromFields(freq, time, weekday, rawCron)
  // The composer's own frequencies always build a valid expression; only the custom
  // cron box can be empty or malformed. Gating Create on validity is what stops an
  // untouched box from arming a schedule (#470) — it no longer falls back to
  // `* * * * *`, which would have spawned an agent session every minute.
  const cronValid = isValidCronExpression(cron)
  const cronInvalid = freq === 'cron' && cron.length > 0 && !cronValid
  const canCreate =
    kind === 'schedule' &&
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    cronValid &&
    !saving

  const create = (): void => {
    if (!canCreate) return
    setSaving(true)
    setError('')
    trpc.automations.create
      .mutate({
        name: name.trim(),
        // Global = no repo: the session spawns in the home directory.
        repoPath: target === GLOBAL_TARGET ? null : target,
        cron,
        agentKind: agent,
        model,
        effort,
        prompt: prompt.trim(),
        enabled,
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
                    aria-invalid={cronInvalid}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {cronInvalid
                      ? 'Not a valid cron expression — 5 fields: minute hour day month weekday.'
                      : 'Five fields: minute hour day month weekday. At most one run every 5 minutes.'}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                <span className="text-[11px] text-muted-foreground">cron</span>
                <code className="font-mono text-[12px] text-foreground">{cron || '—'}</code>
                <span className="text-[11px] text-muted-foreground/70">server-local time</span>
              </div>
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
          <Button type="button" disabled={!canCreate} onClick={create}>
            {saving ? 'Creating…' : 'Create automation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
