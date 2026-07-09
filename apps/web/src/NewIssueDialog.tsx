import { shallowEqual } from '@podium/client-core/store'
import { resolveRole } from '@podium/core'
import { ISSUE_STAGES, type IssueStage, IssueType } from '@podium/protocol'
import { FolderGit2, GitBranch, Plus } from 'lucide-react'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { AUTO } from './agent-models'
import { repoUsageAt } from './derive'
import {
  issueAgentDefaultLabel,
  issueAgentIcon,
  issueAgentLabel,
  issueAgentOptions,
  issueDefaultAgentKind,
} from './issue-agents'
import { STAGE_LABELS } from './issue-card'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'
import { EffortPicker, ModelPicker } from './ModelEffortPicker'
import { PropertyMenu, type PropertyOption } from './PropertyMenu'
import { useStoreSelector } from './store'

/** A Linear search hit. Not exported from the protocol — the server returns this
 *  shape from `issues.linearSearch`, so we mirror it inline. */
interface LinearHit {
  identifier: string
  title: string
  url: string
}

const NEW_BRANCH_VALUE = '__new__'

/** The repo basename, falling back to the full path — repos are shown by name. */
function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function branchPillLabel(branch: string, primaryBranch: string): string {
  if (branch === NEW_BRANCH_VALUE) return 'New'
  return branch === primaryBranch ? `${branch} (default)` : branch
}

function uniqueBranches(branches: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const branch of branches) {
    const trimmed = branch.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Small outlined pill used as a `PropertyMenu` trigger in the composer's property
 *  row. Forwards ref + injected props so Base UI's `render={…}` wires the open
 *  handler onto the button. */
const PillButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & { icon?: ReactNode; label: string }
>(({ icon, label, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="outline"
    size="sm"
    className="h-6 gap-1 rounded-full px-2 text-[12px] font-normal"
    {...props}
  >
    {icon}
    {label}
  </Button>
))
PillButton.displayName = 'PillButton'

export function NewIssueDialog({
  onClose,
  initialStage,
}: {
  onClose: () => void
  /** Lane the composer was opened from. Presets the Stage pill; creation itself is
   *  always Backlog server-side, so a non-backlog stage is applied as a post-create
   *  patch. */
  initialStage?: IssueStage
}): JSX.Element {
  const { trpc, repos, issues, sessions } = useStoreSelector(
    (s) => ({ trpc: s.trpc, repos: s.repos, issues: s.issues, sessions: s.sessions ?? [] }),
    shallowEqual,
  )
  const isMobile = useIsMobile()
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stage, setStage] = useState<IssueStage>(initialStage ?? 'backlog')
  const [priority, setPriority] = useState(2)
  const [type, setType] = useState<IssueType>('task')
  const [assignee, setAssignee] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  // Default repo = the most recently used one (mount-time snapshot).
  const [repoPath, setRepoPath] = useState(() => {
    const choices = repos.filter((r) => r.kind !== 'worktree')
    const mru = [...choices].sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))[0]
    return mru?.path ?? repos[0]?.path ?? ''
  })
  const [branchChoice, setBranchChoice] = useState('')
  const [defaultAgent, setDefaultAgent] = useState('claude-code')
  const [settingsParentBranch, setSettingsParentBranch] = useState('main')
  // '' = use the configured default agent (no flag).
  const [agent, setAgent] = useState('')
  // 'auto' = inherit the settings default model/effort (no per-issue override).
  const [model, setModel] = useState(AUTO)
  const [effort, setEffort] = useState(AUTO)
  const [startNow, setStartNow] = useState(true)
  const [createMore, setCreateMore] = useState(false)
  const [linear, setLinear] = useState<{ identifier: string; url: string } | undefined>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LinearHit[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((settings) => {
        if (cancelled) return
        setDefaultAgent(resolveRole(settings, 'coding').harness)
        setSettingsParentBranch(settings.gitWorkflow.defaultParentBranch || 'main')
      })
      .catch(() => {
        // Best-effort: creation still works with the server defaults.
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  // Suggestion pools drawn from the issues already in play.
  const assigneeOptions: PropertyOption[] = [
    ...new Set(issues.map((i) => i.assignee).filter((a): a is string => !!a)),
  ]
    .sort()
    .map((a) => ({ value: a, label: a }))
  const labelOptions: PropertyOption[] = [...new Set(issues.flatMap((i) => i.labels))]
    .sort()
    .map((l) => ({ value: l, label: l }))
  // Most-recently-used repos first — matches the sidebar's New-agent menu.
  const repoChoices = repos
    .filter((r) => r.kind !== 'worktree')
    .sort(
      (a, b) =>
        repoUsageAt(b, sessions) - repoUsageAt(a, sessions) ||
        repoLabel(a.path).localeCompare(repoLabel(b.path), undefined, { sensitivity: 'base' }),
    )
  const selectedRepo = repos.find((r) => r.path === repoPath)
  const primaryBranch = selectedRepo?.branch?.trim() || settingsParentBranch || 'main'
  const selectedBranch = branchChoice || primaryBranch
  const branchOptions: PropertyOption[] = [
    ...uniqueBranches([
      primaryBranch,
      ...(selectedRepo?.worktrees ?? []).map((w) => w.branch ?? ''),
    ]).map((branch) => ({
      value: branch,
      label: branchPillLabel(branch, primaryBranch),
      icon: <GitBranch size={13} aria-hidden="true" className="text-muted-foreground" />,
    })),
    {
      value: NEW_BRANCH_VALUE,
      label: 'New',
      icon: <Plus size={13} aria-hidden="true" className="text-muted-foreground" />,
    },
  ]
  const repoOptions: PropertyOption[] = repoChoices.map((r) => ({
    value: r.path,
    label: repoLabel(r.path),
    icon: <FolderGit2 size={13} aria-hidden="true" className="text-muted-foreground" />,
  }))
  const stageOptions: PropertyOption[] = ISSUE_STAGES.map((s) => ({
    value: s,
    label: STAGE_LABELS[s],
    icon: <StageGlyph stage={s} />,
  }))
  const priorityOptions: PropertyOption[] = [0, 1, 2, 3, 4].map((p) => ({
    value: String(p),
    label: `P${p}`,
    icon: <PriorityGlyph priority={p} />,
  }))
  const typeOptions: PropertyOption[] = [...IssueType.options].map((t) => ({ value: t, label: t }))
  const agentOptions: PropertyOption[] = issueAgentOptions(defaultAgent)
  // Model + effort are scoped to the effective agent; changing agent resets both
  // (a model/effort valid for one CLI is usually meaningless for another).
  const agentKind = issueDefaultAgentKind(agent || defaultAgent)
  const selectAgent = (value: string) => {
    setAgent(value)
    setModel(AUTO)
    setEffort(AUTO)
  }

  const canSubmit = Boolean(title.trim()) && Boolean(repoPath) && !busy

  const searchLinear = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setError('')
    try {
      setResults(await trpc.issues.linearSearch.query({ query: q }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  const importHit = (hit: LinearHit) => {
    setTitle(hit.title)
    setLinear({ identifier: hit.identifier, url: hit.url })
    if (!description.trim()) setDescription(`From ${hit.identifier}: ${hit.url}`)
  }

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const created = await trpc.issues.create.mutate({
        repoPath,
        title: title.trim(),
        description: description.trim() || undefined,
        parentBranch:
          selectedBranch === NEW_BRANCH_VALUE
            ? primaryBranch || undefined
            : selectedBranch || undefined,
        defaultAgent: agent || undefined,
        defaultModel: model !== AUTO ? model : undefined,
        defaultEffort: effort !== AUTO ? effort : undefined,
        startNow,
        linear,
        // Omit fields at their defaults so a bare issue stays bare.
        ...(priority !== 2 ? { priority } : {}),
        ...(type !== 'task' ? { type } : {}),
        ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
        ...(labels.length ? { labels } : {}),
      })
      // `create` always lands in Backlog, so honor the chosen stage with a follow-up
      // patch. Backlog is the default — no patch needed.
      if (stage !== 'backlog') {
        await trpc.issues.update.mutate({ id: created.id, patch: { stage } })
      }
      if (createMore) {
        // Keep the chosen properties; clear only the per-issue text and refocus.
        setTitle('')
        setDescription('')
        setLinear(undefined)
        setQuery('')
        setResults([])
        setBusy(false)
        titleRef.current?.focus()
      } else {
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-2xl flex-col gap-3 overflow-y-auto sm:max-w-2xl"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New Issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            ref={titleRef}
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            className="border-none px-0 font-medium text-[15px] shadow-none focus-visible:ring-0"
          />

          <Textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add description…"
            className="min-h-40 border-none px-0 shadow-none focus-visible:ring-0"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <PropertyMenu
              trigger={
                <PillButton icon={<StageGlyph stage={stage} />} label={STAGE_LABELS[stage]} />
              }
              options={stageOptions}
              selectedValue={stage}
              onSelect={(v) => setStage(v as IssueStage)}
            />
            <PropertyMenu
              trigger={
                <PillButton icon={<PriorityGlyph priority={priority} />} label={`P${priority}`} />
              }
              options={priorityOptions}
              selectedValue={String(priority)}
              onSelect={(v) => setPriority(Number(v))}
            />
            <PropertyMenu
              trigger={<PillButton label={type} />}
              options={typeOptions}
              selectedValue={type}
              onSelect={(v) => setType(v as IssueType)}
            />
            <PropertyMenu
              trigger={<PillButton label={labels.length ? labels.join(', ') : 'Labels'} />}
              options={labelOptions}
              allowFreeText
              placeholder="Add label…"
              onSelect={(v) =>
                setLabels((ls) => (ls.includes(v) ? ls.filter((x) => x !== v) : [...ls, v]))
              }
            />
            <PropertyMenu
              trigger={<PillButton label={assignee || 'Assignee'} />}
              options={assigneeOptions}
              allowFreeText
              selectedValue={assignee}
              placeholder="Assign to…"
              onSelect={setAssignee}
            />
            <PropertyMenu
              trigger={
                <PillButton
                  icon={<FolderGit2 size={13} aria-hidden="true" />}
                  label={repoLabel(repoPath) || 'Repo'}
                />
              }
              options={repoOptions}
              selectedValue={repoPath}
              placeholder="Select a repo…"
              onSelect={(v) => {
                setRepoPath(v)
                setBranchChoice('')
              }}
            />
            <PropertyMenu
              trigger={
                <PillButton
                  icon={<GitBranch size={13} aria-hidden="true" />}
                  label={branchPillLabel(selectedBranch, primaryBranch)}
                />
              }
              options={branchOptions}
              selectedValue={selectedBranch}
              placeholder="Select a branch…"
              onSelect={setBranchChoice}
            />
            <PropertyMenu
              trigger={
                <PillButton
                  icon={issueAgentIcon(agent || defaultAgent, 13)}
                  label={agent ? issueAgentLabel(agent) : issueAgentDefaultLabel(defaultAgent)}
                />
              }
              options={agentOptions}
              selectedValue={agent}
              onSelect={selectAgent}
            />
            <ModelPicker
              agentKind={agentKind}
              value={model}
              onChange={(m) => {
                // Effort is per-model — reset it whenever the model changes.
                setModel(m)
                setEffort(AUTO)
              }}
            />
            <EffortPicker agentKind={agentKind} model={model} value={effort} onChange={setEffort} />
          </div>

          <Label className="cursor-pointer">
            <Checkbox checked={startNow} onCheckedChange={(c) => setStartNow(c === true)} />
            Start work now
          </Label>

          <details className="rounded-lg border border-border px-3 py-2 text-[13px]">
            <summary className="cursor-pointer select-none text-foreground">Advanced</summary>
            <div className="mt-2 flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label>Import from Linear</Label>
                <div className="flex gap-2">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void searchLinear()
                      }
                    }}
                    placeholder="Search Linear issues…"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={searching || !query.trim()}
                    onClick={() => void searchLinear()}
                  >
                    {searching ? 'Searching…' : 'Search'}
                  </Button>
                </div>
                {results.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {results.map((r) => (
                      <li key={r.identifier}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal"
                          onClick={() => importHit(r)}
                        >
                          <span className="font-mono text-muted-foreground">{r.identifier}</span>{' '}
                          {r.title}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {linear && (
                  <p className="text-[12px] text-muted-foreground">Linked to {linear.identifier}</p>
                )}
              </div>
            </div>
          </details>

          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <Label className="cursor-pointer gap-2 font-normal text-[13px] text-muted-foreground">
            <Switch checked={createMore} onCheckedChange={(c) => setCreateMore(c === true)} />
            Create more
          </Label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
