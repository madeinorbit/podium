/**
 * THE AUTOMATION COMPOSER, AS DATA (POD-409) [spec:SP-17db].
 *
 * `NewAutomationDialog` used to branch per trigger type inline: an `if (kind ===
 * 'schedule')` around one JSX tree, an `if (kind === 'reactive')` around another,
 * and inside the first, four more `freq === …` branches. This file is the same
 * form expressed as SUBFORM CONFIGS — one entry per trigger kind, each a list of
 * field descriptors — so the dialog renders a list instead of choosing a branch,
 * and a fifth frequency is a config entry rather than a fifth conditional.
 *
 * Everything here is pure: no JSX, no DOM, no store. The dialog binds it; the
 * card list (`ScheduledSection`) consumes the SAME rights predicate, which is the
 * point of the shape — an action the principal may not perform must be
 * unreachable from every surface, not only from the one that remembered to check.
 *
 * WHY THIS IS NOT A POD-330 SLICE. POD-330's slices are the five named ones
 * (worklist, chat, issues, terminal, machines); automations is not among them,
 * and inventing a sixth would be a bigger claim than this residual makes. What
 * DOES come from the slices comes from the slices: machine authority
 * (`machineViews` / `MachineAvailability`) and `repoUsageAt` are imported from
 * `@podium/client-core/viewmodels` rather than re-derived here. What is left is
 * automations-specific and lives beside the only feature that renders it.
 *
 * ## Rights (`docs/multi-user-readiness.md` §3.1.6 S5/S6, §3.1.4 M1/M5)
 *
 * A scheduled automation is a DELEGATION, not a setting: it runs as its creator
 * with that person's rights resolved live at every apply, so the composer must
 * say so, and the choices it offers must be bounded by the machines that person
 * may USE. Gating here is UX only — the Authority re-authorizes at apply (ADR 3
 * D8) — so nothing in this file decides anything; it only declines to OFFER.
 */
import {
  type MachineAvailability,
  type MachineView,
  machineViews,
  repoUsageAt,
} from '@podium/client-core/viewmodels'
import type { AutomationSessionMode, GitRepositoryWire, MachineWire } from '@podium/model'
import type { IssueAgentKind } from '@/lib/issue-agents'
import type { Frequency } from './cron-format'
import { cronFromFields, isValidCronExpression } from './cron-format'

export type TriggerKind = 'schedule' | 'reactive'
export type ReactiveTrigger = 'merge-main' | 'new-issue' | 'worktree-idle' | 'file-changed'

/** Sentinel for the repo picker's "no repo" option: the automation runs in the home
 *  directory (repo_path NULL server-side) [spec:SP-17db]. */
export const GLOBAL_TARGET = '__global__'

// ---------------------------------------------------------------------------
// Form state — one flat record, so a field config can name its binding by key.
// ---------------------------------------------------------------------------

export interface AutomationFormState {
  name: string
  kind: TriggerKind
  freq: Frequency
  time: string
  weekday: number
  rawCron: string
  runAt: string
  reactive: ReactiveTrigger
  glob: string
  target: string
  prompt: string
  agent: IssueAgentKind
  model: string
  effort: string
  enabled: boolean
  sessionMode: AutomationSessionMode
}

/** What the dialog knows that the form state does not: the choices available to
 *  this principal right now. Passed to the option and hint functions so a config
 *  entry can be data even when its options are per-principal. */
export interface AutomationFormContext {
  readonly targets: readonly AutomationTargetChoice[]
  readonly excluded: AutomationTargetExclusions
}

// ---------------------------------------------------------------------------
// Field descriptors.
// ---------------------------------------------------------------------------

export interface AutomationOption {
  readonly value: string
  readonly label: string
  /** Rendered but unselectable — an opaque reference, never a choice. */
  readonly disabled?: boolean
}

type Control =
  | { readonly control: 'text'; readonly placeholder?: string; readonly mono?: boolean }
  | { readonly control: 'textarea'; readonly placeholder?: string }
  | { readonly control: 'time' }
  | { readonly control: 'datetime' }
  | {
      readonly control: 'select'
      readonly options:
        | readonly AutomationOption[]
        | ((ctx: AutomationFormContext) => readonly AutomationOption[])
    }
  | { readonly control: 'switch' }
  /** Agent + model + effort: one composite row, because model and effort are
   *  scoped to the agent and resetting them together is the behaviour. */
  | { readonly control: 'agent-runtime' }
  /** The read-back line under the schedule fields ("cron  0 9 * * *"). */
  | { readonly control: 'schedule-summary' }
  | { readonly control: 'notice'; readonly tone: 'warning' | 'info' }

export type AutomationFieldConfig = Control & {
  /** DOM id and test hook; unique across the whole composed form. */
  readonly id: string
  /** The state key this control writes. Absent for read-only controls. */
  readonly field?: keyof AutomationFormState
  readonly label?: string
  /** Omitted from the rendered form when this returns false. */
  readonly visibleWhen?: (state: AutomationFormState) => boolean
  /** The help line under the control. */
  readonly hint?: (state: AutomationFormState, ctx: AutomationFormContext) => string
  readonly invalidWhen?: (state: AutomationFormState) => boolean
}

export interface AutomationSubformConfig {
  readonly id: TriggerKind
  readonly label: string
  readonly fields: readonly AutomationFieldConfig[]
  /** Reactive automations have no runner yet — the shape is real, Create is not. */
  readonly creatable: boolean
  readonly uncreatableReason?: string
}

const FREQUENCIES: readonly AutomationOption[] = [
  { value: 'once', label: 'One time' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Custom cron' },
]

const REACTIVE_TRIGGERS: readonly AutomationOption[] = [
  { value: 'merge-main', label: 'Branch merged to main' },
  { value: 'new-issue', label: 'New task created' },
  { value: 'worktree-idle', label: 'Worktree goes idle' },
  { value: 'file-changed', label: 'File changed' },
]

const WEEKDAY_OPTIONS: readonly AutomationOption[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
].map((label, i) => ({ value: String(i), label }))

/** The schedule subform. The `freq === …` conditionals the dialog used to hold
 *  are now `visibleWhen` predicates on the fields they used to wrap. */
const SCHEDULE_FIELDS: readonly AutomationFieldConfig[] = [
  {
    id: 'automation-frequency',
    field: 'freq',
    label: 'Frequency',
    control: 'select',
    options: FREQUENCIES,
  },
  {
    id: 'automation-run-at',
    field: 'runAt',
    label: 'Run at',
    control: 'datetime',
    visibleWhen: (s) => s.freq === 'once',
    hint: (s) =>
      scheduleValid(s)
        ? 'This automation will run once, at this local date and time.'
        : 'Choose a date and time in the future.',
  },
  {
    id: 'automation-weekday',
    field: 'weekday',
    label: 'Day of week',
    control: 'select',
    options: WEEKDAY_OPTIONS,
    visibleWhen: (s) => s.freq === 'weekly',
  },
  {
    id: 'automation-time',
    field: 'time',
    label: 'Time',
    control: 'time',
    visibleWhen: (s) => s.freq === 'daily' || s.freq === 'weekly',
  },
  {
    id: 'automation-cron',
    field: 'rawCron',
    label: 'Cron expression',
    control: 'text',
    placeholder: '*/30 * * * *',
    mono: true,
    visibleWhen: (s) => s.freq === 'cron',
    invalidWhen: (s) => cronInvalid(s),
    hint: (s) =>
      cronInvalid(s)
        ? 'Not a valid cron expression — 5 fields: minute hour day month weekday.'
        : 'Five fields: minute hour day month weekday. Minimum interval: one minute.',
  },
  { id: 'automation-schedule-summary', control: 'schedule-summary' },
]

const REACTIVE_FIELDS: readonly AutomationFieldConfig[] = [
  {
    id: 'automation-reactive-notice',
    control: 'notice',
    tone: 'warning',
    hint: () =>
      'Reactive automations are not yet wired to a runner — this shape is design only, and Create stays disabled. Scheduled automations are real.',
  },
  {
    id: 'automation-reactive',
    field: 'reactive',
    label: 'Trigger',
    control: 'select',
    options: REACTIVE_TRIGGERS,
  },
  {
    id: 'automation-glob',
    field: 'glob',
    label: 'Path glob',
    control: 'text',
    placeholder: 'src/**/*.ts',
    mono: true,
    visibleWhen: (s) => s.reactive === 'file-changed',
  },
]

export const AUTOMATION_SUBFORMS: readonly AutomationSubformConfig[] = [
  { id: 'schedule', label: 'Schedule', fields: SCHEDULE_FIELDS, creatable: true },
  {
    id: 'reactive',
    label: 'Reactive loop',
    fields: REACTIVE_FIELDS,
    creatable: false,
    uncreatableReason: 'Reactive automations have no runner yet.',
  },
]

/** Fields shared by every subform, above and below the per-type block. */
export const AUTOMATION_HEAD_FIELDS: readonly AutomationFieldConfig[] = [
  {
    id: 'automation-name',
    field: 'name',
    label: 'Name',
    control: 'text',
    placeholder: 'e.g. Nightly test sweep',
  },
]

export const AUTOMATION_TAIL_FIELDS: readonly AutomationFieldConfig[] = [
  {
    id: 'automation-target',
    field: 'target',
    label: 'Target',
    control: 'select',
    options: (ctx) =>
      ctx.targets.map((t) => ({
        value: t.value,
        label: t.label,
        ...(t.opaque === true ? { disabled: true } : {}),
      })),
    hint: (_s, ctx) => targetExclusionNote(ctx.excluded),
  },
  {
    id: 'automation-session-mode',
    field: 'sessionMode',
    label: 'Session mode',
    control: 'select',
    options: [
      { value: 'fresh', label: 'Fresh task and session each run' },
      { value: 'resume', label: 'Resume the previous session' },
    ],
    hint: () =>
      'Resume falls back to a fresh automation issue if the previous session was deleted or never became resumable.',
  },
  {
    id: 'automation-prompt',
    field: 'prompt',
    label: 'Task prompt',
    control: 'textarea',
    placeholder: 'What should the agent do each run?',
  },
  { id: 'automation-agent', control: 'agent-runtime', label: 'Agent' },
  {
    id: 'automation-enabled',
    field: 'enabled',
    label: 'Enabled — start firing on this schedule',
    control: 'switch',
  },
]

/** Drop the entries whose `visibleWhen` says no. This is the whole of what used
 *  to be the dialog's per-type branching. */
export function visibleFields(
  fields: readonly AutomationFieldConfig[],
  state: AutomationFormState,
): AutomationFieldConfig[] {
  return fields.filter((f) => f.visibleWhen?.(state) ?? true)
}

/** The whole form for a given state: head, the subform for the chosen trigger
 *  kind, then tail — with every `visibleWhen` already applied. The dialog renders
 *  the head above the trigger-kind tabs and the rest below, so it composes the
 *  two halves itself; this is the flat view, for tests and for any surface that
 *  wants the form as one list. */
export function automationFormFields(state: AutomationFormState): AutomationFieldConfig[] {
  return visibleFields(
    [...AUTOMATION_HEAD_FIELDS, ...automationSubform(state.kind).fields, ...AUTOMATION_TAIL_FIELDS],
    state,
  )
}

export function automationSubform(kind: TriggerKind): AutomationSubformConfig {
  const found = AUTOMATION_SUBFORMS.find((s) => s.id === kind)
  if (!found) throw new Error(`unknown automation trigger kind: ${kind}`)
  return found
}

// ---------------------------------------------------------------------------
// Schedule derivation — the cron guard, out of the component.
// ---------------------------------------------------------------------------

export function automationCron(state: AutomationFormState): string {
  return cronFromFields(state.freq, state.time, state.weekday, state.rawCron)
}

/** The custom-cron box is the only one that can be malformed; the composer's own
 *  frequencies always build a valid expression. */
export function cronInvalid(state: AutomationFormState): boolean {
  const cron = automationCron(state)
  return state.freq === 'cron' && cron.length > 0 && !isValidCronExpression(cron)
}

/** The instant the run-at box PARSES to, or null when it is empty or malformed.
 *  Says nothing about whether it is in the future — that is {@link scheduleValid}
 *  — because the read-back line shows what was typed even when it is refused. */
export function runAtInstant(state: AutomationFormState): string | null {
  const ts = new Date(state.runAt).getTime()
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

/** The one-off instant, or null when the box is empty, unparseable or in the past. */
export function oneOffRunAt(state: AutomationFormState, now = Date.now()): string | null {
  const parsed = runAtInstant(state)
  return parsed !== null && Date.parse(parsed) > now ? parsed : null
}

/**
 * THE CRON GUARD (POD-470). An empty or malformed custom-cron box must not arm a
 * schedule: it used to fall back to `* * * * *`, which would spawn an agent
 * session every minute. Validity gates Create, and it lives here so the guard is
 * one predicate rather than a condition spread across a JSX tree.
 */
export function scheduleValid(state: AutomationFormState, now = Date.now()): boolean {
  if (state.freq === 'once') return oneOffRunAt(state, now) !== null
  return isValidCronExpression(automationCron(state))
}

// ---------------------------------------------------------------------------
// Targets — owned compute, bounded by machine USE (§3.1.4 M1/M5).
// ---------------------------------------------------------------------------

export interface AutomationTargetChoice {
  readonly value: string
  readonly label: string
  readonly availability: MachineAvailability
  /**
   * An OPAQUE REFERENCE (§3.1.2): the automation being edited already points
   * here, but this principal may not use it. It renders — a picker that silently
   * dropped the saved target would read as "no repo", which is a different
   * automation — and it cannot be chosen. It is never offered for a new one.
   */
  readonly opaque?: true
}

/** How many targets were withheld, and why. Unauthorized and unreachable are
 *  separate counters because they produce the same empty list and mean opposite
 *  things (M5): one is "ask the owner", the other is "try later". */
export interface AutomationTargetExclusions {
  readonly unauthorized: number
  readonly unreachable: number
}

export const NO_TARGET_EXCLUSIONS: AutomationTargetExclusions = {
  unauthorized: 0,
  unreachable: 0,
}

const repoLabel = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/**
 * Grants for the machines we can see.
 *
 * `MachineWire.use` is optional and an omitted value means NOT EVALUATED. Reading
 * that as "denied" for every machine would leave today's single-machine
 * deployments with an empty repo picker, and single-user parity is this issue's
 * regression guard. So the reading is per-LIST, not per-machine: if ANY visible
 * machine carries a `use` decision the server is evaluating scoping, and every
 * machine is then read strictly (an omitted `use` in a scoped list is denied). If
 * NONE does, the list is unscoped and use is not being decided at all.
 *
 * This is safe because it is UX only — the Authority re-authorizes at apply — and
 * it fails closed the moment the server starts answering the question.
 */
export function automationMachineViews(
  machines: readonly MachineWire[],
): MachineView<MachineWire>[] {
  const scoped = machines.some((m) => m.use !== undefined)
  return machineViews(machines, (m) => ({
    see: true,
    use: scoped ? m.use === 'granted' : true,
    manage: m.owned === true,
  }))
}

/**
 * The repos this automation may target, most-recently-used first, plus the count
 * of those withheld and why.
 *
 * Repos are per-machine FACTS (§3.1.1, owned compute): a repo's availability IS
 * its machine's. Only `available` targets are offered — M5's "an unusable target
 * must not be offerable" — and worktrees are excluded as before, since an
 * automation targets a checkout the scheduler owns, not someone's active branch.
 */
export function automationTargetChoices(
  repos: readonly GitRepositoryWire[],
  sessions: readonly { cwd: string; lastActiveAt: string }[],
  views: readonly MachineView<MachineWire>[],
  currentPath?: string | null,
): { choices: AutomationTargetChoice[]; excluded: AutomationTargetExclusions } {
  const availabilityOf = new Map(views.map((v) => [v.machine.id, v.availability]))
  const choices: AutomationTargetChoice[] = []
  const withheld: AutomationTargetChoice[] = []
  let unauthorized = 0
  let unreachable = 0
  for (const repo of repos) {
    if (repo.kind === 'worktree') continue
    // No machineId means an unscoped legacy row, not an unknown machine: the
    // server did not stamp one, so there is no machine decision to honour.
    const availability =
      repo.machineId === undefined
        ? 'available'
        : (availabilityOf.get(repo.machineId) ?? 'unauthorized')
    const choice = { value: repo.path, label: repoLabel(repo.path), availability }
    if (availability === 'available') {
      choices.push(choice)
      continue
    }
    if (availability === 'unauthorized') unauthorized += 1
    else unreachable += 1
    withheld.push(choice)
  }
  choices.sort((a, b) => usageAt(repos, b.value, sessions) - usageAt(repos, a.value, sessions))
  // Home directory: always offerable, and always last — it is the "no repo" answer
  // rather than a target that could be withheld.
  choices.push({
    value: GLOBAL_TARGET,
    label: 'Global (home directory)',
    availability: 'available',
  })
  // The saved target, when this principal cannot use it. Withheld-but-current is
  // shown opaquely; withheld-and-unrelated stays withheld.
  if (currentPath != null && !choices.some((c) => c.value === currentPath)) {
    const known = withheld.find((c) => c.value === currentPath)
    choices.push({
      value: currentPath,
      label: `${repoLabel(currentPath)} — ${
        known?.availability === 'unreachable' ? 'machine offline' : 'not available to you'
      }`,
      availability: known?.availability ?? 'unauthorized',
      opaque: true,
    })
  }
  return { choices, excluded: { unauthorized, unreachable } }
}

function usageAt(
  repos: readonly GitRepositoryWire[],
  path: string,
  sessions: readonly { cwd: string; lastActiveAt: string }[],
): number {
  const repo = repos.find((r) => r.path === path)
  return repo ? repoUsageAt(repo, [...sessions]) : 0
}

/** The sentence under the Target picker when something was withheld. Empty when
 *  nothing was — an absent explanation is better than a reassuring one. */
export function targetExclusionNote(excluded: AutomationTargetExclusions): string {
  const parts: string[] = []
  if (excluded.unauthorized > 0)
    parts.push(
      `${excluded.unauthorized} ${plural(excluded.unauthorized)} on machines you may not run on`,
    )
  if (excluded.unreachable > 0)
    parts.push(
      `${excluded.unreachable} ${plural(excluded.unreachable)} on machines that are offline`,
    )
  if (parts.length === 0) return ''
  return `Not shown: ${parts.join('; ')}.`
}

const plural = (n: number): string => (n === 1 ? 'repo' : 'repos')

// ---------------------------------------------------------------------------
// The rights predicate — one evaluation, every surface (§3.1.6 S5/S6).
// ---------------------------------------------------------------------------

export type AutomationAction = 'create' | 'edit' | 'enable' | 'disable' | 'delete'

export type AutomationDenial =
  /** §3.1.6 S5: a system automation has no human behind it and must not be given one. */
  | 'system'
  /** Personal-class and private by default (§3.1.1) — someone else's delegation. */
  | 'not-owner'
  /** POD-1077 evict: it left this principal's view without being deleted. */
  | 'evicted'
  /** No machine the principal may USE can run this. */
  | 'no-usable-machine'

export type AutomationRightDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AutomationDenial; readonly message: string }

const ALLOWED: AutomationRightDecision = { allowed: true }

const deny = (reason: AutomationDenial, message: string): AutomationRightDecision => ({
  allowed: false,
  reason,
  message,
})

export interface AutomationRightsContext {
  /** §3.1.6 S5 — the steward, expiry jobs, boot reconcile, derived-field upkeep. */
  readonly systemClass: boolean
  /** This principal owns the automation (true for one they are about to create). */
  readonly owned: boolean
  /** The referent is still in this principal's view. False after an evict. */
  readonly visible: boolean
  /** At least one target the principal may USE. Only gates the code-running acts. */
  readonly hasUsableTarget: boolean
}

export const NEW_AUTOMATION_RIGHTS = (hasUsableTarget: boolean): AutomationRightsContext => ({
  systemClass: false,
  owned: true,
  visible: true,
  hasUsableTarget,
})

/**
 * May this principal perform this action?
 *
 * The order is the point. System class refuses first and refuses everything —
 * S5's "must not be given a human" is not a permission that a grant could
 * unlock. Then ownership, then visibility, and only then machine USE, which
 * gates the acts that RUN CODE (create, edit, enable) and deliberately not
 * `disable` or `delete`: an owner must always be able to stop or remove their own
 * delegation, including one pointed at a machine they lost access to. That is the
 * case where failing closed on USE would trap the automation running.
 */
export function automationRight(
  action: AutomationAction,
  ctx: AutomationRightsContext,
): AutomationRightDecision {
  if (ctx.systemClass)
    return deny('system', 'This is a system automation. It runs as the system and has no owner.')
  if (!ctx.owned) return deny('not-owner', 'This automation belongs to someone else.')
  if (!ctx.visible) return deny('evicted', 'This automation is no longer visible to you.')
  if ((action === 'create' || action === 'edit' || action === 'enable') && !ctx.hasUsableTarget)
    return deny(
      'no-usable-machine',
      'No machine you may run on can host this automation right now.',
    )
  return ALLOWED
}

// ---------------------------------------------------------------------------
// Automation class — the S5 seam.
// ---------------------------------------------------------------------------

/**
 * Is this a SYSTEM automation (§3.1.6 S5) — the steward, expiry jobs, boot
 * reconcile, derived-field upkeep — rather than a person's delegation?
 *
 * `AutomationWire` carries NO class field today, so this reads `false` for every
 * automation and behaviour is exactly today's, which is the single-user parity
 * this issue is guarded by. The read is deliberately structural rather than a
 * typed port: a port whose every member is optional is a weak type that any
 * object satisfies, and asserting a field the schema does not have would be a
 * different lie than admitting it. When the server stamps the class (POD-1075's
 * area), this becomes a typed field read and every call site is already correct.
 */
export function automationClassOf(a: object): 'system' | 'user' {
  return (a as { system?: unknown }).system === true ? 'system' : 'user'
}

/** The list a user composes from. System automations are not user work and are
 *  not shown here at all (S5) — not shown-and-disabled, which would still invite
 *  the question of who owns them. */
export function userAutomations<T extends object>(automations: readonly T[]): T[] {
  return automations.filter((a) => automationClassOf(a) === 'user')
}

// ---------------------------------------------------------------------------
// The mutation payload.
// ---------------------------------------------------------------------------

/**
 * The `automations.create` / `.update` input for this form state.
 *
 * NO ACTOR, OWNER OR ORIGIN (§3.1.3 A3, ADR 3 D7): attribution is stamped from
 * the authenticated transport, never asserted by the client. If a field of that
 * shape ever appears in this object, it is a bug, not a feature.
 */
export interface AutomationInput<S extends string = string> {
  name: string
  repoPath: string | null
  scheduleKind: 'once' | 'cron'
  cron: string | null
  runAt: string | null
  /** Generic in the session-id brand so an edit hands back exactly the branded id
   *  it was given, rather than widening it to `string` on the way through. */
  targetSessionId: S | null
  agentKind: IssueAgentKind
  model: string
  effort: string
  prompt: string
  enabled: boolean
  sessionMode: AutomationSessionMode
}

export function automationInput<S extends string>(
  state: AutomationFormState,
  existing: { targetSessionId: S | null } | null,
): AutomationInput<S> {
  const once = state.freq === 'once'
  return {
    name: state.name.trim(),
    repoPath: state.target === GLOBAL_TARGET ? null : state.target,
    scheduleKind: once ? 'once' : 'cron',
    cron: once ? null : automationCron(state),
    runAt: once ? oneOffRunAt(state) : null,
    // Agent-created targeted one-offs keep their explicit session when edited.
    targetSessionId: existing?.targetSessionId ?? null,
    agentKind: state.agent,
    model: state.model,
    effort: state.effort,
    prompt: state.prompt.trim(),
    enabled: state.enabled,
    sessionMode: state.sessionMode,
  }
}

/** Everything Create needs to be true. Composed from the subform's own
 *  creatability, the rights decision and the schedule guard, so the button's
 *  disabled state has exactly one source. */
export function canSaveAutomation(
  state: AutomationFormState,
  right: AutomationRightDecision,
  now = Date.now(),
): boolean {
  if (!right.allowed) return false
  if (!automationSubform(state.kind).creatable) return false
  return state.name.trim().length > 0 && state.prompt.trim().length > 0 && scheduleValid(state, now)
}
