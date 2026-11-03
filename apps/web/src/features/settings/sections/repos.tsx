import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import { podiumDefaultLabel } from '@podium/client-graph/repo-base-branch'
import {
  type SettingsCheckout,
  SettingsRepositories,
  type SettingsRepository,
  type SettingsWorktree,
} from '@podium/client-graph/settings-repositories'
import { isValidPrefix } from '@podium/protocol'
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Pencil, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useId, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { RepoBaseBranchMenu, usePodiumDefaultParentBranch } from '@/lib/BaseBranchMenu'
import { REF_PREFIXES_CHANGED_EVENT } from '@/lib/ref-activation'
import { cn } from '@/lib/utils'

/**
 * SETTINGS → REPOSITORIES [POD-6267], replacing the #474 prefix list.
 *
 * One row per REPOSITORY, not per registered path. The old list printed every
 * scan row a machine reported, and a registered worktree is a scan row, so a
 * repository with forty task worktrees read as forty repositories, each with
 * the same prefix and its own "Change…" button. `SettingsRepositories` now
 * groups the scans; this file only draws them.
 *
 * A row answers, left to right, the three questions this page exists for:
 * which repository (name, remote), how its tasks are numbered (prefix) and
 * where its new tasks start (base branch). Under it, where it lives: one line
 * per checkout with its machine, path and branch, and the worktrees that
 * checkout has out folded behind a count. The worktrees are the detail, never
 * the list.
 */

const createRepositories = (pool: MobxPool) => new SettingsRepositories(pool)

/** Identity column, then the two fields, on one right edge for every row. */
const ROW_GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_7.5rem_13.5rem] md:items-start md:gap-x-5'
/** A field's trigger: the outline control, in the row's type size. */
const FIELD =
  'h-8 w-full justify-between gap-2 px-2.5 font-normal text-[13px] [&_svg]:text-text-faint'
/** A checkout line: machine, path, branch, worktrees. */
const CHECKOUT_GRID = 'sm:grid sm:grid-cols-[8rem_minmax(0,1fr)_9.5rem_11rem]'
/** Worktrees shown before "Show all": enough to recognise, not a wall. */
const WORKTREE_PREVIEW = 8

export const ReposSection = observer(function ReposSection(): JSX.Element {
  const view = useOpeningView(useWorklistPool(), createRepositories)
  // Until the machines' list arrives, an empty list means "not yet", not "none".
  const rows = view?.loaded ? view.rows : undefined
  const empty = rows !== undefined && rows.length === 0
  return (
    <section aria-labelledby="repos-heading">
      <div className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 id="repos-heading" className="settings-h">
            Repositories
          </h3>
          <p className="settings-prose mt-1">
            Every repository Podium works in, and where each one is checked out. The prefix numbers
            a repository's tasks; the base branch is where its new tasks branch from and land.
          </p>
        </div>
        {!empty && (
          <Button
            type="button"
            variant="outline"
            className="flex-none"
            onClick={openAddProject}
            data-testid="settings-add-repository"
          >
            <Plus aria-hidden="true" />
            Add repository
          </Button>
        )}
      </div>
      {rows === undefined ? (
        <RepoListSkeleton />
      ) : empty ? (
        <NoRepositories />
      ) : (
        <RepoList rows={rows} />
      )}
    </section>
  )
})

const RepoList = observer(function RepoList({
  rows,
}: {
  rows: readonly SettingsRepository[]
}): JSX.Element {
  const podiumDefault = usePodiumDefaultParentBranch()
  return (
    <div>
      <div
        aria-hidden="true"
        className={cn('settings-micro hidden border-hairline-soft border-b pb-2 md:grid', ROW_GRID)}
      >
        <span>Repository</span>
        <span>Prefix</span>
        <span>Base branch</span>
      </div>
      <ul aria-label="Repositories">
        {rows.map((row) => (
          <RepoRow key={row.key} row={row} podiumDefault={podiumDefault} />
        ))}
      </ul>
    </div>
  )
})

const RepoRow = observer(function RepoRow({
  row,
  podiumDefault,
}: {
  row: SettingsRepository
  podiumDefault: string | undefined
}): JSX.Element {
  const edit = usePrefixEdit(row)
  return (
    <li
      className="border-hairline-soft/60 border-b py-4 last:border-b-0"
      data-testid="settings-repo-row"
    >
      <div className={cn('flex flex-col gap-3', ROW_GRID)}>
        <div className="min-w-0 md:pt-[5px]">
          <div className="settings-label truncate" title={row.name}>
            {row.name}
          </div>
          <div
            className={cn('settings-micro mt-0.5 truncate', row.origin && 'font-mono')}
            title={row.origin ?? undefined}
          >
            {row.origin ?? 'Local only, no remote'}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:contents">
          <LabelledCell label="Prefix">
            {edit.open ? (
              <PrefixInput row={row} edit={edit} />
            ) : (
              <PrefixField row={row} edit={edit} />
            )}
          </LabelledCell>
          <LabelledCell label="Base branch">
            <BaseBranchField row={row} podiumDefault={podiumDefault} />
          </LabelledCell>
        </div>
      </div>
      {edit.open && <PrefixConsequences row={row} edit={edit} />}
      <CheckoutList row={row} />
    </li>
  )
})

/** On a phone the column header is gone, so each field names itself. */
function LabelledCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="settings-micro mb-1 md:hidden">{label}</div>
      {children}
    </div>
  )
}

// ── Prefix ──────────────────────────────────────────────────────────────────

/** One inline edit of one repository's prefix: the field in its column and the
 *  strip under the row read the same draft. */
interface PrefixEdit {
  open: boolean
  draft: string
  error: string | null
  saving: boolean
  hintId: string
  start(): void
  cancel(): void
  type(value: string): void
  submit(): Promise<void>
}

function usePrefixEdit(row: SettingsRepository): PrefixEdit {
  const trpc = useSettingsTrpc()
  const hintId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  return {
    open,
    draft,
    error,
    saving,
    hintId,
    start() {
      setDraft(row.prefix ?? '')
      setError(null)
      setOpen(true)
    },
    cancel() {
      if (!saving) setOpen(false)
    },
    type(value) {
      setDraft(value.toUpperCase().replace(/[^A-Z]/g, ''))
      setError(null)
    },
    async submit() {
      if (draft === (row.prefix ?? '')) return setOpen(false)
      if (!isValidPrefix(draft)) {
        setError('A prefix is 2 to 5 letters, A to Z.')
        return
      }
      // The write names one checkout; the server resolves its repository.
      const target = row.writeCheckout
      if (!target) {
        setError('No machine reports this repository right now.')
        return
      }
      setSaving(true)
      setError(null)
      try {
        await trpc.repos.setPrefix.mutate({
          path: target.path,
          prefix: draft,
          ...(target.machineId ? { machineId: target.machineId } : {}),
        })
        // Tell the linkifiers' prefix sync to refetch: old refs stop resolving now.
        window.dispatchEvent(new Event(REF_PREFIXES_CHANGED_EVENT))
        setOpen(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving(false)
      }
    },
  }
}

const PrefixField = observer(function PrefixField({
  row,
  edit,
}: {
  row: SettingsRepository
  edit: PrefixEdit
}): JSX.Element {
  const registered = row.repoId !== null && row.checkouts.length > 0
  return (
    <Button
      type="button"
      variant="outline"
      className={FIELD}
      disabled={!registered}
      title={
        registered
          ? 'Change the prefix'
          : 'Podium is still registering this repository; its prefix can be set once it has.'
      }
      aria-label={
        row.prefix
          ? `Prefix for ${row.name}: ${row.prefix}. Change`
          : `Set a prefix for ${row.name}`
      }
      onClick={edit.start}
      data-testid="repo-prefix"
    >
      {row.prefix ? (
        <span className="settings-value truncate">{row.prefix}</span>
      ) : (
        <span className="truncate text-muted-foreground">None</span>
      )}
      <Pencil size={12} aria-hidden="true" className="flex-none" />
    </Button>
  )
})

function PrefixInput({ row, edit }: { row: SettingsRepository; edit: PrefixEdit }): JSX.Element {
  return (
    <Input
      className="h-8 font-mono uppercase tracking-[0.06em]"
      value={edit.draft}
      autoFocus
      maxLength={5}
      spellCheck={false}
      autoComplete="off"
      disabled={edit.saving}
      aria-label={`Prefix for ${row.name}`}
      aria-describedby={edit.hintId}
      aria-invalid={edit.error !== null || undefined}
      onChange={(e) => edit.type(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void edit.submit()
        if (e.key === 'Escape') edit.cancel()
      }}
      data-testid="repo-prefix-input"
    />
  )
}

/** What saving would do, and the commit, as wide as the row. */
const PrefixConsequences = observer(function PrefixConsequences({
  row,
  edit,
}: {
  row: SettingsRepository
  edit: PrefixEdit
}): JSX.Element {
  const valid = isValidPrefix(edit.draft)
  const changed = edit.draft !== (row.prefix ?? '')
  return (
    <div
      id={edit.hintId}
      className="settings-section-enter mt-3 flex flex-col gap-3 rounded-lg border border-hairline-soft bg-muted/20 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p
          className={cn('settings-micro', edit.error && 'text-destructive!')}
          role={edit.error ? 'alert' : undefined}
        >
          {edit.error ??
            (valid
              ? `Tasks in ${row.name} will read ${edit.draft}-1, ${edit.draft}-2, and so on.`
              : 'Two to five letters, A to Z, not used by another repository.')}
        </p>
        {row.prefix && changed && !edit.error && (
          <p className="settings-micro mt-0.5 text-warning!">
            Refs already written as {row.prefix}-13 will stop linking.
          </p>
        )}
      </div>
      <div className="flex flex-none justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={edit.saving}
          onClick={edit.cancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={edit.saving || (changed && !valid)}
          onClick={() => void edit.submit()}
          data-testid="repo-prefix-save"
        >
          {edit.saving ? 'Saving…' : 'Save prefix'}
        </Button>
      </div>
    </div>
  )
})

// ── Base branch ─────────────────────────────────────────────────────────────

const BaseBranchField = observer(function BaseBranchField({
  row,
  podiumDefault,
}: {
  row: SettingsRepository
  podiumDefault: string | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const repoId = row.repoId
  const checkout = row.writeCheckout
  const own = row.defaultParentBranch
  const label = own ?? (podiumDefault === undefined ? null : podiumDefaultLabel(podiumDefault))
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={FIELD}
            disabled={!repoId || !checkout}
            title={
              own
                ? 'New tasks here branch from this and land on it'
                : 'No base branch of its own: new tasks use the Podium default from Git workflow'
            }
            aria-label={`Base branch for ${row.name}: ${own ?? 'Podium default'}`}
            data-testid="repo-base-branch"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch size={13} aria-hidden="true" className="flex-none" />
              <span
                className={cn('truncate font-mono text-[12.5px]', !own && 'text-muted-foreground')}
              >
                {label ?? '…'}
              </span>
              {!own && <span className="flex-none text-text-faint text-[12px]">default</span>}
            </span>
            <ChevronDown size={13} aria-hidden="true" className="flex-none" />
          </Button>
        }
      />
      {open && repoId && checkout && (
        <RepoBaseBranchMenu
          repoId={repoId}
          path={checkout.path}
          machineId={checkout.machineId ?? undefined}
          align="end"
          onDone={() => setOpen(false)}
        />
      )}
    </DropdownMenu>
  )
})

// ── Checkouts and worktrees ─────────────────────────────────────────────────

const CheckoutList = observer(function CheckoutList({
  row,
}: {
  row: SettingsRepository
}): JSX.Element | null {
  const checkouts = row.checkouts
  if (!checkouts.length) return null
  return (
    <ul
      aria-label={`Where ${row.name} is checked out`}
      className="mt-3 divide-y divide-hairline-soft/50 rounded-lg border border-hairline-soft/80 bg-muted/15"
    >
      {checkouts.map((checkout) => (
        <CheckoutLine key={checkout.scan.id} checkout={checkout} />
      ))}
    </ul>
  )
})

const CheckoutLine = observer(function CheckoutLine({
  checkout,
}: {
  checkout: SettingsCheckout
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const worktrees = checkout.worktrees
  const count = worktrees.length
  const missing = checkout.missingWorktreeCount
  const online = checkout.machineOnline
  const state = online === null ? 'Machine unknown' : online ? 'Online' : 'Offline'
  return (
    <li>
      {/* Fixed columns from sm up, so branches and worktree counts line up
          down the well; on a phone the path takes a second line instead. */}
      <div
        className={cn(
          'flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 pr-1.5 pl-3 text-[12.5px]',
          CHECKOUT_GRID,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 max-sm:flex-1" title={state}>
          <span
            role="img"
            aria-label={state}
            className={cn(
              'size-1.5 flex-none rounded-full',
              online ? 'bg-success' : 'bg-muted-foreground/40',
            )}
          />
          <span
            className={cn(
              'truncate',
              online === false ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {checkout.machineName ?? 'Unknown machine'}
          </span>
        </span>
        <span
          className="order-last min-w-0 basis-full truncate pl-3.5 font-mono text-[12px] text-muted-foreground sm:order-none sm:pl-0"
          title={checkout.path}
        >
          {checkout.path}
        </span>
        <CheckoutHead checkout={checkout} />
        {count > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="flex-none justify-self-start gap-1 px-2 font-normal text-[12px] text-muted-foreground sm:-ml-2"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
            data-testid="checkout-worktrees"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'transition-transform duration-150 motion-reduce:transition-none',
                open && 'rotate-90',
              )}
            />
            <span className="tabular-nums">
              {count} {count === 1 ? 'worktree' : 'worktrees'}
            </span>
            {missing > 0 && <span className="text-warning">· {missing} missing</span>}
          </Button>
        ) : (
          <span className="flex-none text-[12px] text-text-faint max-sm:px-2">No worktrees</span>
        )}
      </div>
      {open && count > 0 && <WorktreeList id={listId} worktrees={worktrees} />}
    </li>
  )
})

/** What the checkout has out: its branch, or what it is when it has none. */
const CheckoutHead = observer(function CheckoutHead({
  checkout,
}: {
  checkout: SettingsCheckout
}): JSX.Element {
  if (checkout.bare) {
    return <span className="min-w-0 flex-none text-[12px] text-text-faint">bare clone</span>
  }
  return (
    <span className="flex min-w-0 flex-none items-center gap-1 text-[12px] max-sm:max-w-[11rem]">
      <GitBranch size={12} aria-hidden="true" className="flex-none text-text-faint" />
      <span className="truncate font-mono text-foreground" title={checkout.branch ?? undefined}>
        {checkout.branch ?? 'detached'}
      </span>
      {checkout.linked && <span className="flex-none text-text-faint">· worktree</span>}
    </span>
  )
})

function WorktreeList({
  id,
  worktrees,
}: {
  id: string
  worktrees: readonly SettingsWorktree[]
}): JSX.Element {
  const [all, setAll] = useState(worktrees.length <= WORKTREE_PREVIEW + 2)
  const shown = all ? worktrees : worktrees.slice(0, WORKTREE_PREVIEW)
  return (
    <div
      id={id}
      className="settings-section-enter border-hairline-soft/50 border-t pt-1 pb-2 pl-[1.625rem] pr-3"
    >
      <ul aria-label="Worktrees">
        {shown.map((worktree) => (
          <li
            key={worktree.path}
            className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 text-[12px] max-sm:py-1"
          >
            <span className="flex min-w-0 items-center gap-1.5 max-sm:flex-1 sm:w-[13.5rem] sm:flex-none">
              <GitBranch size={11} aria-hidden="true" className="flex-none text-text-faint" />
              <span
                className={cn(
                  'truncate font-mono',
                  worktree.branch ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={worktree.branch}
              >
                {worktree.branch ?? 'detached'}
              </span>
            </span>
            <span
              className="order-last min-w-0 basis-full truncate pl-[17px] font-mono text-text-faint sm:order-none sm:basis-auto sm:flex-initial sm:pl-0"
              title={worktree.path}
            >
              {worktree.path}
            </span>
            {worktree.prunable && (
              <span
                className="flex-none text-warning"
                title="The folder is gone; git keeps the entry until `git worktree prune`."
              >
                missing
              </span>
            )}
            {worktree.locked && <span className="flex-none text-text-faint">locked</span>}
          </li>
        ))}
      </ul>
      {!all && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="-ml-2 mt-1 font-normal text-muted-foreground"
          onClick={() => setAll(true)}
        >
          Show all {worktrees.length}
        </Button>
      )}
    </div>
  )
}

// ── Loading and empty ───────────────────────────────────────────────────────

/** Two still rows in the list's own shape. No shimmer: on this screen the only
 *  thing that moves is an agent working. */
function RepoListSkeleton(): JSX.Element {
  return (
    <div role="status" aria-busy="true" aria-label="Loading repositories">
      {[0, 1].map((i) => (
        <div
          key={i}
          className={cn(
            'flex flex-col gap-3 border-hairline-soft/60 border-b py-4 last:border-b-0',
            ROW_GRID,
          )}
        >
          <div className="space-y-2 md:pt-1.5">
            <div className="h-3.5 w-28 rounded bg-muted" />
            <div className="h-3 w-48 rounded bg-muted/60" />
          </div>
          <div className="hidden h-8 rounded-lg bg-muted/50 md:block" />
          <div className="hidden h-8 rounded-lg bg-muted/50 md:block" />
        </div>
      ))}
    </div>
  )
}

function NoRepositories(): JSX.Element {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border border-dashed px-6 py-10 text-center">
      <FolderGit2 size={20} aria-hidden="true" className="text-text-faint" />
      <p className="settings-label mt-3">No repositories yet</p>
      <p className="settings-prose mt-1">
        Add a folder on one of your machines, or clone one from a Git URL. Tasks, worktrees and
        agent sessions all start in a repository.
      </p>
      <Button type="button" className="mt-4" onClick={openAddProject}>
        <Plus aria-hidden="true" />
        Add repository
      </Button>
    </div>
  )
}
