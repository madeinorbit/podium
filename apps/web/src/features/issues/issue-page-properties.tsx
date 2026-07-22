/**
 * The Linear-style properties sidebar for the issue page — a stack of labeled
 * `PropertyMenu`/inline rows, plus the ported Sessions and Git action blocks.
 * Rendered in the desktop `<aside>` and (mirrored) inside the mobile `Details`
 * disclosure. Split out of IssuePage.tsx (P5d, issue #264): all mutations go
 * through the named commands in ./issue-page-commands.ts; derivations come from
 * ./issue-page-model.ts. No behavior change.
 */
import { shallowEqual } from '@podium/client-core'
import {
  ISSUE_DEP_TYPES,
  ISSUE_STAGES,
  IssueType,
  type IssueWire,
  issueDisplayRef,
} from '@podium/protocol'
import { ChevronDown, ExternalLink, Plus, X } from 'lucide-react'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { relativeTime } from '@/lib/home'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentDefaultLabel,
  issueAgentIcon,
  issueAgentLabel,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { PropertyMenu, type PropertyOption } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import { issueRefLong, STAGE_LABELS } from './issue-card'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'
import type { IssueCloseReason } from './issue-lifecycle'
import type { IssuePageCommands } from './issue-page-commands'
import {
  assigneeOptionsOf,
  labelPoolOf,
  mateOptionsOf,
  repoMatesOf,
  UNASSIGNED,
  useMergeStyle,
} from './issue-page-model'
import { groupRelations } from './issue-relations'

/** One labeled row in the properties sidebar: a fixed-width label + a value cell. */
function PropertyRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="w-20 shrink-0 pt-1 text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The full-width ghost button used as a PropertyMenu trigger (shows the current
 *  value; the whole cell is clickable). Forwards ref + injected props so Base UI's
 *  `DropdownMenuTrigger render={…}` can wire the open handler onto the button. */
const TriggerButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & { testId?: string }
>(({ children, testId, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="sm"
    data-testid={testId}
    className="h-7 w-full justify-start gap-1.5 px-2 font-normal text-[13px]"
    {...props}
  >
    {children}
  </Button>
))
TriggerButton.displayName = 'TriggerButton'

export function IssueAgentAction({
  mode,
  defaultAgent,
  busy,
  onDefault,
  onAgent,
}: {
  mode: 'start' | 'session'
  defaultAgent: string
  busy: boolean
  onDefault: () => void
  onAgent: (agentKind: IssueAgentKind) => void
}): JSX.Element {
  const primaryLabel = mode === 'start' ? 'Start work' : '+ Session'
  const chooseTitle = mode === 'start' ? 'Choose start agent' : 'Choose session agent'
  const variant = mode === 'start' ? undefined : 'secondary'
  const defaultKind = issueDefaultAgentKind(defaultAgent)
  const defaultLabel = issueAgentDefaultLabel(defaultAgent)
  return (
    <div className="inline-flex">
      <Button
        type="button"
        variant={variant}
        size="sm"
        className="rounded-r-none"
        disabled={busy}
        onClick={onDefault}
      >
        {primaryLabel}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant={variant}
              size="sm"
              className="rounded-l-none border-l-0 px-2"
              disabled={busy}
              title={chooseTitle}
              aria-label={chooseTitle}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onDefault}>
            {issueAgentIcon(defaultAgent)}
            {mode === 'start' ? `Start with ${defaultLabel}` : `New ${defaultLabel} session`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {ISSUE_AGENT_KINDS.filter((kind) => kind !== defaultKind).map((kind) => (
            <DropdownMenuItem key={kind} onClick={() => onAgent(kind)}>
              {issueAgentIcon(kind)}
              {mode === 'start'
                ? `Start with ${issueAgentLabel(kind)}`
                : `New ${issueAgentLabel(kind)} session`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The properties stack. `commands` is the page's named-command set (all
 *  mutations run through its toast-wrapping runner); `onNavigate` re-points the
 *  open issue (parent / relation click-through). */
export function IssueProperties({
  issue,
  busy,
  commands,
  onNavigate,
  onRequestClose,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssuePageCommands
  onNavigate: (id: string) => void
  onRequestClose: (reason: IssueCloseReason) => void
}): JSX.Element {
  const { trpc, issues, machines, sessions, navigateToSession } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      issues: s.issues,
      machines: s.machines,
      sessions: s.sessions,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  const mergeStyle = useMergeStyle(trpc)
  const now = Date.now()
  const [deferDate, setDeferDate] = useState('')
  // Relation add is two steps: pick a dep type, then a target issue.
  const [addRelType, setAddRelType] = useState('blocks')

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setDeferDate('')
    setAddRelType('blocks')
  }, [issue.id])

  // Repo-mates: the pool for relations + parent, excluding self, seq-ordered.
  const repoMates = repoMatesOf(issues, issue)
  const byId = new Map(issues.map((i) => [i.id, i]))
  const issueLabel = (id: string): string => {
    const m = byId.get(id)
    return m ? issueRefLong(m) : id
  }
  const mateOptions = mateOptionsOf(repoMates)
  const assigneeOptions = assigneeOptionsOf(issues)
  const labelPool = labelPoolOf(issues, issue)

  // [spec:SP-a1c0] (#411) Route through the central action — never roll per-feature
  // navigation (setPane+setView flips the URL then reverts off the workspace view).
  const openSession = (session: { sessionId: string }): void => {
    navigateToSession(session.sessionId)
  }
  const primaryIsPr = mergeStyle === 'pr'
  const mergeLabel = 'FF-only merge'

  const relations = groupRelations(issue)
  const parent = issue.parentId ? byId.get(issue.parentId) : undefined

  // Forwarding ghosts (POD-89): sessions BORN here (permanent refIssueId) that
  // re-homed elsewhere. "No agents" was misread as work lost — the honest shape
  // is "the agent moved on to POD-x".
  const movedOn = (sessions ?? []).filter(
    (s) => s.refIssueId === issue.id && s.issueId != null && s.issueId !== issue.id && !s.archived,
  )

  // ---- Status: lifecycle stages reopen a closed issue; close choices are guarded
  // by the shared dialog mounted on the full page. ----
  const statusOptions: PropertyOption[] = [
    ...ISSUE_STAGES.map((s) => ({
      value: `stage:${s}`,
      label: STAGE_LABELS[s],
      icon: <StageGlyph stage={s} />,
    })),
    { value: 'close:done', label: 'Close: done' },
    { value: 'close:wontfix', label: 'Close: wontfix' },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        {/* Status */}
        <PropertyRow label="Status">
          <PropertyMenu
            selectedValue={`stage:${issue.stage}`}
            options={statusOptions}
            onSelect={(value) => {
              if (value === 'close:done') onRequestClose('done')
              else if (value === 'close:wontfix') onRequestClose('wontfix')
              else commands.selectStatus(value)
            }}
            trigger={
              <TriggerButton disabled={busy} testId="status-trigger">
                <StageGlyph stage={issue.stage} />
                {issue.closedReason ? `Closed — ${issue.closedReason}` : STAGE_LABELS[issue.stage]}
              </TriggerButton>
            }
          />
        </PropertyRow>

        {/* Priority */}
        <PropertyRow label="Priority">
          <PropertyMenu
            selectedValue={String(issue.priority)}
            options={[0, 1, 2, 3, 4].map((p) => ({
              value: String(p),
              label: `P${p}`,
              icon: <PriorityGlyph priority={p} />,
            }))}
            onSelect={(v) => commands.update({ priority: Number(v) })}
            trigger={
              <TriggerButton disabled={busy}>
                <PriorityGlyph priority={issue.priority} />P{issue.priority}
              </TriggerButton>
            }
          />
        </PropertyRow>

        {/* Assignee */}
        <PropertyRow label="Assignee">
          <PropertyMenu
            allowFreeText
            selectedValue={issue.assignee ?? UNASSIGNED}
            options={assigneeOptions}
            placeholder="Assign to…"
            onSelect={(v) => commands.update({ assignee: v === UNASSIGNED ? '' : v })}
            trigger={
              <TriggerButton disabled={busy}>
                {issue.assignee || <span className="text-muted-foreground">Unassigned</span>}
              </TriggerButton>
            }
          />
        </PropertyRow>

        {/* Type */}
        <PropertyRow label="Type">
          <PropertyMenu
            selectedValue={issue.type}
            options={IssueType.options.map((t) => ({ value: t, label: t }))}
            onSelect={(v) => commands.update({ type: v as IssueType })}
            trigger={<TriggerButton disabled={busy}>{issue.type}</TriggerButton>}
          />
        </PropertyRow>

        {/* Labels */}
        <PropertyRow label="Labels">
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/5 py-0.5 pr-1 pl-1.5 text-[11px] text-primary"
              >
                {label}
                <button
                  type="button"
                  aria-label={`Remove label ${label}`}
                  title={`Remove ${label}`}
                  disabled={busy}
                  className="rounded-sm text-primary/70 hover:text-primary disabled:opacity-50"
                  onClick={() => commands.removeLabel(label)}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
            <PropertyMenu
              allowFreeText
              options={labelPool.map((l) => ({ value: l, label: l }))}
              placeholder="Add label…"
              onSelect={commands.addLabel}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground"
                >
                  <Plus size={12} aria-hidden="true" /> Add
                </Button>
              }
            />
          </div>
        </PropertyRow>

        {/* Estimate (minutes) */}
        <PropertyRow label="Estimate">
          <Input
            key={`estimate-${issue.id}`}
            type="number"
            min={0}
            defaultValue={issue.estimateMin ?? ''}
            placeholder="minutes"
            aria-label="Estimate (minutes)"
            disabled={busy}
            className="h-7 max-w-[120px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            onBlur={(e) => {
              const raw = e.currentTarget.value.trim()
              if (raw === '') return
              const n = Number(raw)
              if (!Number.isInteger(n) || n === (issue.estimateMin ?? null)) return
              commands.update({ estimateMin: n })
            }}
          />
        </PropertyRow>

        {/* Due date */}
        <PropertyRow label="Due">
          <div className="flex items-center gap-1.5">
            <Input
              key={`due-${issue.id}`}
              type="date"
              defaultValue={issue.dueAt ? issue.dueAt.slice(0, 10) : ''}
              aria-label="Due date"
              disabled={busy}
              className="h-7 max-w-[150px]"
              onChange={(e) => commands.setDueDate(e.currentTarget.value)}
            />
            {issue.dueAt && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Clear due date"
                aria-label="Clear due date"
                disabled={busy}
                onClick={() => commands.setDueDate('')}
              >
                <X size={13} aria-hidden="true" />
              </Button>
            )}
          </div>
        </PropertyRow>

        {/* Defer */}
        <PropertyRow label="Defer">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="date"
              value={deferDate}
              aria-label="Defer until"
              disabled={busy}
              className="h-7 max-w-[150px]"
              onChange={(e) => setDeferDate(e.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7"
              disabled={busy || !deferDate}
              onClick={() => commands.defer(deferDate, () => setDeferDate(''))}
            >
              Defer
            </Button>
            {issue.deferUntil && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={commands.undefer}
              >
                Unsnooze
              </Button>
            )}
          </div>
        </PropertyRow>

        {/* Parent */}
        <PropertyRow label="Parent">
          <div className="flex items-center gap-1">
            {parent && (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[13px] text-primary hover:underline"
                onClick={() => onNavigate(parent.id)}
                // Long form, full title on hover (#474 spec §display).
                title={`${issueDisplayRef(parent)} · ${parent.title}`}
              >
                {issueRefLong(parent)}
              </button>
            )}
            <PropertyMenu
              selectedValue={issue.parentId ?? '__none__'}
              options={[{ value: '__none__', label: 'No parent' }, ...mateOptions]}
              placeholder="Set parent…"
              onSelect={(v) => commands.setParent(v === '__none__' ? null : v)}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className={cn('h-7 gap-1 px-2 text-[13px]', parent ? '' : 'w-full justify-start')}
                >
                  {parent ? 'Change' : <span className="text-muted-foreground">No parent</span>}
                </Button>
              }
            />
          </div>
        </PropertyRow>

        {/* Linear (integration link — identifier + click-through) */}
        {(issue.linearUrl || issue.linearIdentifier) && (
          <PropertyRow label="Linear">
            {issue.linearUrl ? (
              <a
                href={issue.linearUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 pt-1 text-[13px] text-primary hover:underline"
              >
                {issue.linearIdentifier ?? 'Open'} <ExternalLink size={12} aria-hidden="true" />
              </a>
            ) : (
              <span className="block pt-1 text-[13px]">{issue.linearIdentifier}</span>
            )}
          </PropertyRow>
        )}
      </div>

      {/* Relations */}
      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-[12px] text-muted-foreground">Relations</h3>
        {relations.map((group) => (
          <div key={group.section} className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
              {group.section}
            </span>
            {group.entries.map((entry) => (
              <div
                key={`${group.section}-${entry.direction}-${entry.id}`}
                className="group flex items-center justify-between gap-2"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-[13px] text-foreground hover:text-primary hover:underline"
                  onClick={() => byId.has(entry.id) && onNavigate(entry.id)}
                  title={issueLabel(entry.id)}
                >
                  {issueLabel(entry.id)}
                </button>
                <button
                  type="button"
                  aria-label={`Remove relation ${entry.type} ${entry.id}`}
                  title="Remove relation"
                  disabled={busy}
                  className="shrink-0 rounded-sm text-muted-foreground/60 opacity-0 hover:text-foreground disabled:opacity-50 group-hover:opacity-100"
                  onClick={() => commands.removeRelation(entry)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ))}
        {/* Agent-noted soft blockers (issues.blocked_by / dependency_note) —
            free-text notes, distinct from the real dependency graph above. */}
        {(issue.blockedBy.length > 0 || issue.dependencyNote) && (
          <div
            className="flex flex-col gap-0.5 rounded-md border border-border border-dashed bg-muted/20 px-2 py-1.5"
            data-testid="agent-blockers"
          >
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
              Agent notes
            </span>
            {issue.blockedBy.map((b) => (
              <span key={b} className="break-words text-[12px] text-muted-foreground">
                blocked by: {b}
              </span>
            ))}
            {issue.dependencyNote && (
              <span className="break-words text-[12px] text-muted-foreground">
                {issue.dependencyNote}
              </span>
            )}
          </div>
        )}
        {repoMates.length > 0 && (
          <div className="flex items-center gap-1.5">
            <PropertyMenu
              selectedValue={addRelType}
              options={ISSUE_DEP_TYPES.filter(
                (t) => t !== 'parent-child' && t !== 'supersedes',
              ).map((t) => ({ value: t, label: t }))}
              onSelect={(v) => setAddRelType(v)}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1 px-2 text-[12px]"
                >
                  {addRelType}
                </Button>
              }
            />
            <PropertyMenu
              options={mateOptions}
              placeholder="Add relation…"
              onSelect={(v) => commands.addRelation(addRelType, v)}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
                >
                  <Plus size={12} aria-hidden="true" /> Add relation
                </Button>
              }
            />
          </div>
        )}
      </section>

      {/* Sessions — ported from the detail drawer. */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-[12px] text-muted-foreground">
          Sessions ({issue.sessionSummary.total})
        </h3>
        {/* Model + effort the issue's sessions launch with (scoped to its agent). */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ModelPicker
            agentKind={issueDefaultAgentKind(issue.defaultAgent)}
            value={issue.defaultModel}
            onChange={commands.setDefaultModel}
          />
          <EffortPicker
            agentKind={issueDefaultAgentKind(issue.defaultAgent)}
            model={issue.defaultModel}
            value={issue.defaultEffort}
            onChange={commands.setDefaultEffort}
          />
          {/* Machine pin — which daemon runs this issue's agents ('auto' = repo affinity). */}
          {machines.length > 1 && (
            <PropertyMenu
              selectedValue={issue.machineId ?? 'auto'}
              options={[
                { value: 'auto', label: 'auto machine' },
                ...machines.map((m) => ({
                  value: m.id,
                  label: m.online ? m.name : `${m.name} (offline)`,
                })),
              ]}
              onSelect={(v) => commands.setMachine(v === 'auto' ? null : v)}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1 px-2 text-[12px]"
                >
                  {issue.machineId
                    ? (machines.find((m) => m.id === issue.machineId)?.name ?? issue.machineId)
                    : 'auto machine'}
                </Button>
              }
            />
          )}
        </div>
        {issue.sessions.length > 0 && (
          <div className="flex flex-col gap-1">
            {issue.sessions.map((s) => (
              <Button
                key={s.sessionId}
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal"
                onClick={() => openSession(s)}
              >
                {sessionDisplayName(s)}
              </Button>
            ))}
          </div>
        )}
        {movedOn.length > 0 && (
          <div className="flex flex-col gap-1" data-testid="moved-on-sessions">
            {movedOn.map((s) => {
              const dest = s.issueId ? byId.get(s.issueId) : undefined
              return (
                <Button
                  key={s.sessionId}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal text-muted-foreground opacity-80"
                  title={dest ? `Session continued on ${issueRefLong(dest)}` : 'Session moved on'}
                  onClick={() => openSession(s)}
                >
                  <span className="mr-1.5" aria-hidden="true">
                    ⤷
                  </span>
                  {sessionDisplayName(s)} · continued on{' '}
                  {dest ? issueDisplayRef(dest) : 'another issue'}
                </Button>
              )
            })}
          </div>
        )}
        {issue.worktreePath ? (
          <div className="flex gap-2">
            <IssueAgentAction
              mode="session"
              defaultAgent={issue.defaultAgent}
              busy={busy}
              onDefault={() => commands.addSession()}
              onAgent={(agentKind) => commands.addSession(agentKind)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={commands.addShell}
            >
              + Shell
            </Button>
          </div>
        ) : (
          <IssueAgentAction
            mode="start"
            defaultAgent={issue.defaultAgent}
            busy={busy}
            onDefault={() => commands.startWork()}
            onAgent={(agentKind) => commands.startWork(agentKind)}
          />
        )}
      </section>

      {/* Git — ported from the detail drawer. */}
      {issue.worktreePath && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium text-[12px] text-muted-foreground">Git</h3>
          <div className="flex flex-wrap gap-2">
            {primaryIsPr ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void commands.gitAction('pr')}
              >
                Open PR
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void commands.gitAction('merge')}
              >
                {mergeLabel}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void commands.gitAction('rebase')}
            >
              Rebase on {issue.parentBranch}
            </Button>
            {primaryIsPr ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void commands.gitAction('merge')}
              >
                {mergeLabel}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void commands.gitAction('pr')}
              >
                Open PR
              </Button>
            )}
          </div>
          {issue.prUrl && (
            <a
              href={issue.prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
            >
              View PR <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </section>
      )}

      {/* About — row-level provenance and freshness stamps. */}
      <section
        className="flex flex-col gap-0.5 border-border border-t pt-3"
        data-testid="issue-about"
      >
        <AboutRow
          label="Created"
          value={relativeTime(issue.createdAt, now)}
          title={issue.createdAt}
        />
        <AboutRow
          label="Updated"
          value={relativeTime(issue.updatedAt, now)}
          title={issue.updatedAt}
        />
        <AboutRow label="Origin" value={issue.origin} />
        <AboutRow label="Audience" value={issue.audience} />
      </section>
    </div>
  )
}

/** One muted label/value line in the About block; empty values render nothing. */
function AboutRow({
  label,
  value,
  title,
}: {
  label: string
  value: string
  title?: string
}): JSX.Element | null {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/80" title={title}>
        {value}
      </span>
    </div>
  )
}
