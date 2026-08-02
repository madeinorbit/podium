import { shallowEqual } from '@podium/client-core/store'
import type { AutomationSessionMode } from '@podium/model'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
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
import { ISSUE_AGENT_KINDS, issueAgentLabel, issueDefaultAgentKind } from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import type { Automation } from './AutomationsView'
import {
  AUTOMATION_HEAD_FIELDS,
  AUTOMATION_SUBFORMS,
  AUTOMATION_TAIL_FIELDS,
  type AutomationFieldConfig,
  type AutomationFormContext,
  type AutomationFormState,
  automationClassOf,
  automationCron,
  automationInput,
  automationMachineViews,
  automationRight,
  automationSubform,
  automationTargetChoices,
  canSaveAutomation,
  GLOBAL_TARGET,
  NEW_AUTOMATION_RIGHTS,
  type ReactiveTrigger,
  runAtInstant,
  type TriggerKind,
  visibleFields,
} from './automation-form'
import type { Frequency } from './cron-format'

const localDateTimeValue = (iso?: string | null): string => {
  const fallback = new Date(Date.now() + 60 * 60_000)
  fallback.setSeconds(0, 0)
  const date = iso ? new Date(iso) : fallback
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function initialState(automation: Automation | null, defaultTarget: string): AutomationFormState {
  return {
    name: automation?.name ?? '',
    kind: 'schedule',
    // Existing recurring schedules open as custom cron so their exact expression
    // is preserved.
    freq: automation ? (automation.scheduleKind === 'once' ? 'once' : 'cron') : 'daily',
    time: '09:00',
    weekday: 1, // Monday
    rawCron: automation?.cron ?? '',
    runAt: localDateTimeValue(automation?.runAt),
    reactive: 'merge-main',
    glob: '',
    target: automation ? (automation.repoPath ?? GLOBAL_TARGET) : defaultTarget,
    prompt: automation?.prompt ?? '',
    agent: issueDefaultAgentKind(automation?.agentKind ?? 'claude-code'),
    model: automation?.model ?? AUTO,
    effort: automation?.effort ?? AUTO,
    enabled: automation?.enabled ?? true,
    sessionMode: automation?.sessionMode ?? 'fresh',
  }
}

/**
 * The "New automation" composer (POD-470) [spec:SP-17db], rendered from the
 * subform CONFIGS in `automation-form.ts` (POD-409) rather than from a per-type
 * branch. The dialog's job is now state, submission and the delegation notice;
 * which controls exist for a given trigger kind and frequency is data.
 *
 * Schedule creates a REAL, persisted automation via `automations.create`.
 * Reactive keeps its fields visible — the design intent is real — but its config
 * says `creatable: false`, so Create is disabled and says why: there is no runner
 * behind it yet, and a composer that silently discards its input is exactly what
 * POD-470 removed.
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
  const { repos, sessions, machines } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      sessions: s.sessions ?? [],
      machines: s.machines ?? [],
    }),
    shallowEqual,
  )
  const editing = automation !== null

  // Targets are OWNED COMPUTE: bounded by the machines this principal may USE,
  // with unauthorized and unreachable counted separately (§3.1.4 M5).
  const { choices, excluded } = useMemo(
    () =>
      automationTargetChoices(
        repos,
        sessions,
        automationMachineViews(machines),
        automation?.repoPath ?? null,
      ),
    [repos, sessions, machines, automation?.repoPath],
  )
  const ctx: AutomationFormContext = { targets: choices, excluded }

  const [state, setState] = useState<AutomationFormState>(() =>
    initialState(automation, choices.find((c) => !c.opaque)?.value ?? GLOBAL_TARGET),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const patch = (next: Partial<AutomationFormState>): void =>
    setState((prev) => ({ ...prev, ...next }))

  // One rights evaluation, the same predicate the automation cards use.
  const right = automationRight(
    editing ? 'edit' : 'create',
    NEW_AUTOMATION_RIGHTS(choices.some((c) => !c.opaque)),
  )
  const subform = automationSubform(state.kind)
  const canSave = canSaveAutomation(state, right) && !saving
  const blockedReason = !right.allowed
    ? right.message
    : subform.creatable
      ? ''
      : (subform.uncreatableReason ?? '')

  // §3.1.6 S5: a system automation has no human behind it and must not be given
  // one, so it is never opened as an editable delegation.
  if (automation && automationClassOf(automation) === 'system') {
    return (
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) onClose()
        }}
      >
        <DialogContent className="flex w-full max-w-md flex-col gap-4">
          <DialogHeader>
            <DialogTitle>System automation</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            {automation.name} runs as the system, not as a person. It has no owner and cannot be
            edited or taken over here.
          </p>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  const renderFields = (fields: readonly AutomationFieldConfig[]): JSX.Element[] =>
    visibleFields(fields, state).map((field) => (
      <AutomationField
        key={field.id}
        field={field}
        state={state}
        ctx={ctx}
        onChange={patch}
        onAgentChange={(agent) => patch({ agent, model: AUTO, effort: AUTO })}
      />
    ))

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    setError('')
    const input = automationInput(state, automation)
    const request = automation
      ? trpc.automations.update.mutate({ id: automation.id, patch: input })
      : trpc.automations.create.mutate(input)
    request
      .then(() => onSaved())
      // A denial is surfaced and the dialog stays exactly as the user left it —
      // nothing optimistic was applied, and nothing retries (ADR 3 D8).
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
          {renderFields(AUTOMATION_HEAD_FIELDS)}

          <Tabs value={state.kind} onValueChange={(v) => patch({ kind: v as TriggerKind })}>
            <TabsList className="w-full">
              {AUTOMATION_SUBFORMS.map((s) => (
                <TabsTrigger key={s.id} value={s.id} className="flex-1">
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {renderFields([...subform.fields, ...AUTOMATION_TAIL_FIELDS])}

          {automation?.targetSessionId && (
            <span className="-mt-2 text-[11px] text-muted-foreground">
              Explicit session target: {automation.targetSessionId}
            </span>
          )}

          {/* §3.1.6 S6: this form authors a DELEGATION. Say whose. */}
          <p className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            This automation is yours and runs as you, with whatever access you have at the time it
            fires — not the access you have now. If your access to the target changes, it stops
            working.
          </p>

          {blockedReason && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
              {blockedReason}
            </div>
          )}

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

/** One config entry, rendered. The only place in this feature that knows which
 *  control kind maps to which component. */
function AutomationField({
  field,
  state,
  ctx,
  onChange,
  onAgentChange,
}: {
  field: AutomationFieldConfig
  state: AutomationFormState
  ctx: AutomationFormContext
  onChange: (next: Partial<AutomationFormState>) => void
  onAgentChange: (agent: ReturnType<typeof issueDefaultAgentKind>) => void
}): JSX.Element | null {
  const hint = field.hint?.(state, ctx) ?? ''

  if (field.control === 'notice') {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
        {hint}
      </div>
    )
  }

  if (field.control === 'schedule-summary') {
    const parsed = runAtInstant(state)
    return state.freq === 'once' ? (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
        <span className="text-[11px] text-muted-foreground">one time</span>
        <span className="text-[12px] text-foreground">
          {parsed ? new Date(parsed).toLocaleString() : '—'}
        </span>
      </div>
    ) : (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
        <span className="text-[11px] text-muted-foreground">cron</span>
        <code className="font-mono text-[12px] text-foreground">
          {automationCron(state) || '—'}
        </code>
        <span className="text-[11px] text-muted-foreground/70">server-local time</span>
      </div>
    )
  }

  if (field.control === 'agent-runtime') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={field.id}>{field.label}</Label>
          <Select
            value={state.agent}
            // Model + effort are scoped to the agent — changing it resets both.
            onValueChange={(v) => onAgentChange(issueDefaultAgentKind(v))}
          >
            <SelectTrigger id={field.id} className="w-40">
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
            agentKind={state.agent}
            value={state.model}
            // Effort is per-model — reset it whenever the model changes.
            onChange={(m) => onChange({ model: m, effort: AUTO })}
          />
          <EffortPicker
            agentKind={state.agent}
            model={state.model}
            value={state.effort}
            onChange={(effort) => onChange({ effort })}
          />
        </div>
      </div>
    )
  }

  if (field.control === 'switch') {
    return (
      <Label className="cursor-pointer gap-2 font-normal text-[13px] text-muted-foreground">
        <Switch
          checked={state.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label="Enabled"
        />
        {field.label}
      </Label>
    )
  }

  const key = field.field
  if (key === undefined) return null

  return (
    <div className="flex flex-col gap-1.5">
      {field.label && <Label htmlFor={field.id}>{field.label}</Label>}
      {field.control === 'select' ? (
        <SelectField field={field} state={state} ctx={ctx} onChange={onChange} />
      ) : field.control === 'textarea' ? (
        <Textarea
          id={field.id}
          value={String(state[key])}
          onChange={(e) => onChange({ [key]: e.target.value } as Partial<AutomationFormState>)}
          placeholder={field.placeholder}
          className="min-h-24"
        />
      ) : (
        <Input
          id={field.id}
          type={
            field.control === 'time'
              ? 'time'
              : field.control === 'datetime'
                ? 'datetime-local'
                : 'text'
          }
          value={String(state[key])}
          onChange={(e) => onChange({ [key]: e.target.value } as Partial<AutomationFormState>)}
          placeholder={field.control === 'text' ? field.placeholder : undefined}
          className={
            field.control === 'time'
              ? 'w-32'
              : field.control === 'text' && field.mono
                ? 'font-mono'
                : undefined
          }
          aria-invalid={field.invalidWhen?.(state) ?? undefined}
        />
      )}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

function SelectField({
  field,
  state,
  ctx,
  onChange,
}: {
  field: AutomationFieldConfig & { control: 'select' }
  state: AutomationFormState
  ctx: AutomationFormContext
  onChange: (next: Partial<AutomationFormState>) => void
}): JSX.Element {
  const key = field.field as keyof AutomationFormState
  const options = typeof field.options === 'function' ? field.options(ctx) : field.options
  const value = String(state[key])
  const selected = options.find((o) => o.value === value)
  return (
    <Select value={value} onValueChange={(v) => onChange(coerce(key, v ?? value))}>
      <SelectTrigger id={field.id} className="w-full">
        <SelectValue>{selected?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Select values arrive as strings; `weekday` is the one numeric binding. */
function coerce(key: keyof AutomationFormState, value: string): Partial<AutomationFormState> {
  if (key === 'weekday') return { weekday: Number(value) }
  if (key === 'freq') return { freq: value as Frequency }
  if (key === 'reactive') return { reactive: value as ReactiveTrigger }
  if (key === 'sessionMode') return { sessionMode: value as AutomationSessionMode }
  return { [key]: value } as Partial<AutomationFormState>
}
