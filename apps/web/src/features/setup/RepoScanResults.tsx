import { GitBranch, Globe } from 'lucide-react'
import type { JSX } from 'react'
import { useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import type { RepoCandidate } from './ranking'

/** Rows the server already has: unchecking one asks for its REMOVAL. */
function isRegistered(c: RepoCandidate): boolean {
  return c.status === 'registered' || c.status === 'auto-registered'
}

/**
 * Pick which repos this machine should have. Every checkbox states the DESIRED
 * END STATE, and none are locked (POD-814): checking a candidate queues an add,
 * unchecking an already-registered row queues a removal, and the footer commits
 * the difference. Registered rows used to render as checkmarks the user could not
 * clear, next to a button that said "Add 0 repos" — the list showed a truth you
 * were not allowed to change. This is also how repos get REMOVED: rescan, uncheck,
 * confirm.
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
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(candidates.filter((c) => isRegistered(c) || c.defaultSelected).map((c) => c.path)),
  )

  const visible = useMemo(() => candidates.filter((c) => !c.hidden), [candidates])
  const hidden = useMemo(() => candidates.filter((c) => c.hidden), [candidates])

  // The diff is measured against what the server had when the scan returned, not
  // against the initial checkbox state: a candidate that starts checked is an ADD.
  const { add, remove } = useMemo(() => {
    const registered = new Set(candidates.filter(isRegistered).map((c) => c.path))
    return {
      add: candidates
        .filter((c) => selected.has(c.path) && !registered.has(c.path))
        .map((c) => c.path),
      remove: candidates
        .filter((c) => registered.has(c.path) && !selected.has(c.path))
        .map((c) => c.path),
    }
  }, [candidates, selected])

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

  const selectedCount = selected.size
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
        className="flex max-h-[min(720px,calc(100dvh-32px))] w-full max-w-[640px] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border px-3.5 pt-3.5 pb-2.5">
          <div>
            <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              FIND REPOSITORIES
            </DialogTitle>
            <div className="mt-1 break-words text-[13px] text-foreground">{scannedPath}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {candidates.length} found · {selectedCount} selected
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div className="border-b border-border px-3.5 py-2 text-xs text-destructive">{error}</div>
        )}

        <div className="min-h-[180px] flex-1 overflow-y-auto p-1.5">
          {candidates.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">
              No git repositories found in this folder.
            </div>
          )}
          {visible.length > 0 && (
            <Section
              title="PROJECTS"
              group={visible}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(visible, on)}
            />
          )}
          {hidden.length > 0 && (
            <Section
              title="HIDDEN / SYSTEM"
              group={hidden}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(hidden, on)}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-3.5 py-2.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onBack}
            disabled={saving}
            className="max-md:w-full"
          >
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || changeLabel === ''}
            onClick={() => onApply({ add, remove })}
            className="max-md:w-full"
          >
            {saving ? 'Saving...' : changeLabel === '' ? 'No changes' : changeLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({
  title,
  group,
  selected,
  onToggle,
  onAll,
}: {
  title: string
  group: RepoCandidate[]
  selected: Set<string>
  onToggle: (path: string) => void
  onAll: (on: boolean) => void
}): JSX.Element {
  const allOn = group.length > 0 && group.every((c) => selected.has(c.path))
  const rowIdBase = useId()
  return (
    <div className="mb-2">
      <div className="sticky top-0 flex items-center justify-between bg-popover px-2 pt-2 pb-1">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
          {title}
        </span>
        <Button type="button" variant="outline" size="xs" onClick={() => onAll(!allOn)}>
          {allOn ? 'none' : 'all'}
        </Button>
      </div>
      {group.map((c, i) => (
        // The checkbox sits BESIDE the label rather than inside it: a <label>
        // wrapping a Base UI checkbox swallows clicks on the box itself (the
        // hidden input's click bubbles back out and the label re-forwards it, so
        // the two toggles cancel). `display: contents` keeps the row one grid.
        <div
          key={c.path}
          className="grid cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted max-md:grid-cols-[auto_1fr_auto]"
        >
          <Checkbox
            id={`${rowIdBase}-${i}`}
            aria-label={c.path}
            checked={selected.has(c.path)}
            onCheckedChange={() => onToggle(c.path)}
          />
          <label htmlFor={`${rowIdBase}-${i}`} className="contents cursor-pointer">
            <span className="text-[13px] text-foreground">{c.name}</span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground/70 max-md:col-[2/4] max-md:row-2">
              {c.path}
            </span>
          </label>
          <span className="inline-flex items-center gap-1.5">
            {c.status === 'registered' && (
              <span className="whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground">
                already added
              </span>
            )}
            {c.status === 'auto-registered' && (
              <span
                className="whitespace-nowrap rounded border border-success/40 px-1.5 text-[10px] text-success"
                title={c.alsoOn?.length ? `Same repo as on ${c.alsoOn.join(', ')}` : undefined}
              >
                added automatically
              </span>
            )}
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
                className="inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground"
                title="branch"
              >
                <GitBranch size={11} /> {c.branch}
              </span>
            )}
            {c.hasOrigin && (
              <span
                className="inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground"
                title="has remote"
              >
                <Globe size={11} /> origin
              </span>
            )}
            {c.worktreeCount > 0 && (
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground">
                +{c.worktreeCount} wt
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
