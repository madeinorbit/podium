import { GitBranch, Globe } from 'lucide-react'
import type { JSX } from 'react'
import { useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import type { RepoCandidate } from './ranking'

/** Rows the server already has: unchecking one asks for its REMOVAL. */
function isRegistered(c: RepoCandidate): boolean {
  return c.status === 'registered' || c.status === 'auto-registered'
}

/** What confirming will DO to a row — the thing every row has to say out loud. */
type RowFate = 'keep' | 'remove' | 'add' | 'ignore'

function fateOf(c: RepoCandidate, selected: boolean): RowFate {
  if (isRegistered(c)) return selected ? 'keep' : 'remove'
  return selected ? 'add' : 'ignore'
}

/**
 * Pick which repos this machine should have. Every checkbox states the DESIRED
 * END STATE and none are locked (POD-814): checking a candidate queues an add,
 * unchecking an already-registered row queues a removal, and the footer commits
 * the difference.
 *
 * Rows are grouped BY WHAT THEY ARE (already added / found / hidden) and each one
 * spells out what confirming will do to it (POD-832). Both matter because the end
 * state is editable: with everything merely "checked", a checkmark could mean
 * "already yours" or "about to be added", and an unchecked row could mean "left
 * alone" or "about to be deleted" — the same tick meaning four things. Removals
 * are drawn destructively for the same reason: unchecking an added repo is the
 * only genuinely lossy thing this dialog does, and it used to hide behind a
 * button labelled "none".
 *
 * Nothing is preselected: opening a scan and confirming it is a no-op unless you
 * chose something. Selecting them all is one click away instead.
 */
export function RepoScanResults({
  scannedPath,
  candidates,
  saving,
  error,
  onApply,
  onBack,
}: {
  scannedPath: string
  candidates: RepoCandidate[]
  saving: boolean
  error: string | null
  onApply: (changes: { add: string[]; remove: string[] }) => void
  onBack: () => void
}): JSX.Element {
  const isMobile = useIsMobile()
  // Registered rows start checked because that IS their state. Nothing else does:
  // a scan should never volunteer repos you did not ask for.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.filter(isRegistered).map((c) => c.path)),
  )

  const groups = useMemo(() => {
    const already = candidates.filter(isRegistered)
    const rest = candidates.filter((c) => !isRegistered(c))
    return {
      already,
      found: rest.filter((c) => !c.hidden),
      hidden: rest.filter((c) => c.hidden),
    }
  }, [candidates])

  // The diff is measured against what the server had when the scan returned, not
  // against the initial checkbox state.
  const { add, remove } = useMemo(() => {
    const registered = new Set(groups.already.map((c) => c.path))
    return {
      add: candidates
        .filter((c) => selected.has(c.path) && !registered.has(c.path))
        .map((c) => c.path),
      remove: groups.already.filter((c) => !selected.has(c.path)).map((c) => c.path),
    }
  }, [candidates, groups.already, selected])

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function setGroup(group: RepoCandidate[], on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of group) {
        if (on) next.add(c.path)
        else next.delete(c.path)
      }
      return next
    })
  }

  const changeLabel = [
    ...(add.length > 0 ? [`Add ${add.length}`] : []),
    ...(remove.length > 0 ? [`Remove ${remove.length}`] : []),
  ].join(' · ')

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onBack()
      }}
    >
      <DialogContent
        aria-label="Found repos"
        // sm:max-w-* (not plain max-w-*): DialogContent's base sets sm:max-w-sm,
        // and tailwind-merge only drops a same-variant conflict — an unprefixed
        // max-w loses to the base's sm: rule at desktop width, pinning the dialog
        // to 384px (POD-832).
        className="flex max-h-[min(760px,calc(100dvh-32px))] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]"
      >
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border px-4 pt-3.5 pb-3">
          <div className="min-w-0">
            <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              FIND REPOSITORIES
            </DialogTitle>
            <div className="mt-1 break-words font-mono text-[13px] text-foreground">
              {scannedPath}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {candidates.length} found
              {groups.already.length > 0 && ` · ${groups.already.length} already added`}
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div className="border-b border-border px-4 py-2 text-xs text-destructive">{error}</div>
        )}

        <div className="min-h-[200px] flex-1 overflow-y-auto px-2 py-1.5">
          {candidates.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">
              No git repositories found in this folder.
            </div>
          )}
          {groups.already.length > 0 && (
            <Section
              title="ALREADY ADDED"
              kind="already"
              group={groups.already}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(groups.already, on)}
            />
          )}
          {groups.found.length > 0 && (
            <Section
              title="FOUND — NOT ADDED YET"
              kind="found"
              group={groups.found}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(groups.found, on)}
            />
          )}
          {groups.hidden.length > 0 && (
            <Section
              title="HIDDEN / SYSTEM"
              kind="found"
              group={groups.hidden}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(groups.hidden, on)}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <div className="min-w-0 text-xs text-muted-foreground">
            {changeLabel === '' ? (
              'Nothing selected yet'
            ) : (
              <span className="inline-flex flex-wrap items-center gap-x-1.5">
                {add.length > 0 && (
                  <span>
                    {add.length} to add
                    {remove.length > 0 && ' ·'}
                  </span>
                )}
                {remove.length > 0 && (
                  <span className="font-medium text-destructive">
                    {remove.length} to remove from Podium
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onBack} disabled={saving}>
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              variant={remove.length > 0 && add.length === 0 ? 'destructive' : 'default'}
              disabled={saving || changeLabel === ''}
              onClick={() => onApply({ add, remove })}
            >
              {saving ? 'Saving...' : changeLabel === '' ? 'No changes' : changeLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({
  title,
  kind,
  group,
  selected,
  onToggle,
  onAll,
}: {
  title: string
  /** 'already' rows are ON the server — clearing them DELETES, so say so. */
  kind: 'already' | 'found'
  group: RepoCandidate[]
  selected: Set<string>
  onToggle: (path: string) => void
  onAll: (on: boolean) => void
}): JSX.Element {
  const allOn = group.length > 0 && group.every((c) => selected.has(c.path))
  const rowIdBase = useId()
  // Label the bulk control by its CONSEQUENCE, not by the checkbox state it sets:
  // the same "none" that merely deselects a found repo would drop every repo you
  // already added.
  const bulk =
    kind === 'already'
      ? allOn
        ? { label: 'Remove all', on: false, destructive: true }
        : { label: 'Keep all', on: true, destructive: false }
      : allOn
        ? { label: 'Clear', on: false, destructive: false }
        : { label: `Select all ${group.length}`, on: true, destructive: false }

  return (
    <div className="mb-3">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-popover px-2 pt-2 pb-1.5">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
          {title} <span className="text-muted-foreground/60">({group.length})</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className={cn(
            bulk.destructive &&
              'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive',
          )}
          onClick={() => onAll(bulk.on)}
        >
          {bulk.label}
        </Button>
      </div>
      {group.map((c, i) => {
        const isOn = selected.has(c.path)
        const fate = fateOf(c, isOn)
        return (
          // The checkbox sits BESIDE the label rather than inside it: a <label>
          // wrapping a Base UI checkbox swallows clicks on the box itself (the
          // hidden input's click bubbles back out and the label re-forwards it, so
          // the two toggles cancel). `display: contents` keeps the row one grid.
          <div
            key={c.path}
            className={cn(
              'grid cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2.5 rounded-md border-l-2 py-1.5 pr-2 pl-1.5 transition-colors max-md:grid-cols-[auto_1fr_auto]',
              fate === 'remove' &&
                'border-l-destructive bg-destructive/[0.06] hover:bg-destructive/10',
              fate === 'add' && 'border-l-primary bg-primary/[0.06] hover:bg-primary/10',
              (fate === 'keep' || fate === 'ignore') && 'border-l-transparent hover:bg-muted',
            )}
          >
            <Checkbox
              id={`${rowIdBase}-${i}`}
              aria-label={c.path}
              checked={isOn}
              onCheckedChange={() => onToggle(c.path)}
            />
            <label htmlFor={`${rowIdBase}-${i}`} className="contents cursor-pointer">
              <span
                className={cn(
                  'text-[13px]',
                  fate === 'remove'
                    ? 'text-muted-foreground line-through decoration-destructive/50'
                    : 'text-foreground',
                )}
              >
                {c.name}
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 max-md:col-[2/4] max-md:row-2">
                {c.path}
              </span>
            </label>
            <span className="inline-flex items-center gap-1.5">
              <FateChip fate={fate} status={c.status} alsoOn={c.alsoOn} />
              {c.status === 'candidate' && (c.alsoOn?.length ?? 0) > 0 && (
                <span
                  className="whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground"
                  title={`Same repo as on ${c.alsoOn?.join(', ')}`}
                >
                  also on {c.alsoOn?.[0]}
                </span>
              )}
              {c.branch && (
                <span
                  className="inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground max-md:hidden"
                  title="branch"
                >
                  <GitBranch size={11} /> {c.branch}
                </span>
              )}
              {c.hasOrigin && (
                <span
                  className="inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground max-md:hidden"
                  title="has remote"
                >
                  <Globe size={11} /> origin
                </span>
              )}
              {c.worktreeCount > 0 && (
                <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground max-md:hidden">
                  +{c.worktreeCount} wt
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The row's verdict. Silent for 'ignore' — a repo you simply didn't pick needs
 *  no label, and a chip on every row would drown the two that matter. */
function FateChip({
  fate,
  status,
  alsoOn,
}: {
  fate: RowFate
  status?: RepoCandidate['status']
  alsoOn?: string[]
}): JSX.Element | null {
  if (fate === 'remove')
    return (
      <span className="whitespace-nowrap rounded border border-destructive/40 bg-destructive/10 px-1.5 text-[10px] font-medium text-destructive">
        will be removed
      </span>
    )
  if (fate === 'add')
    return (
      <span className="whitespace-nowrap rounded border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
        will be added
      </span>
    )
  if (fate === 'keep')
    return (
      <span
        className="whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground"
        title={
          status === 'auto-registered' && alsoOn?.length
            ? `Added automatically — same repo as on ${alsoOn.join(', ')}`
            : undefined
        }
      >
        {status === 'auto-registered' ? 'added automatically' : 'added'}
      </span>
    )
  return null
}
