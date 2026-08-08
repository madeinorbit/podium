import { AlertTriangle, GitBranch, HardDrive, RotateCcw, ShieldCheck, Users } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface ReclaimConsequence {
  key: string
  label: string
  detail: string
  /** `cost` is something the operator gives up; `safe` is something preserved. */
  tone: 'cost' | 'safe'
  icon: 'disk' | 'sessions' | 'branch' | 'refuse' | 'rebuild'
}

/**
 * What freeing these checkouts actually does, named one consequence at a time.
 *
 * Deliberately presentation-only, the same shape and for the same reason as
 * {@link issueCloseConcerns} in `features/issues/issue-lifecycle.tsx`: the
 * server stays permissive and the UI makes each issue-owned consequence
 * explicit, so "Free" is an informed decision rather than a second click.
 *
 * The list is the argument for the button, so it names the giveaway AND the
 * guarantees. Both matter here: the giveaway (disk goes, agents stop, the next
 * start pays to rebuild) is why an operator might not do this, and the
 * guarantees (branch kept, dirty tree refuses) are why doing it is not
 * destructive. Omitting either half would make the dialog a rubber stamp.
 */
export function reclaimFreeConsequences(count: number): ReclaimConsequence[] {
  const s = count === 1 ? '' : 's'
  return [
    {
      key: 'disk',
      label: `${count} checkout${s} removed from disk`,
      detail:
        'The worktree directories are deleted on the machine that owns them. Nothing else on the host is touched.',
      tone: 'cost',
      icon: 'disk',
    },
    {
      key: 'sessions',
      label: `Sessions on ${count === 1 ? 'that issue' : 'those issues'} are stopped`,
      detail:
        'Any agent still attached is stopped before the checkout goes. Transcripts and resume refs are kept, so the sessions can be resumed later.',
      tone: 'cost',
      icon: 'sessions',
    },
    {
      key: 'rebuild',
      label: 'The next agent there rebuilds the checkout',
      detail:
        'Starting or resuming on the issue re-creates the worktree from the branch. That costs a fresh git worktree add plus any install or build state that lived only in the old directory.',
      tone: 'cost',
      icon: 'rebuild',
    },
    {
      key: 'branch',
      label: `Branch${s} ${count === 1 ? 'is' : 'are'} kept — no code is lost`,
      detail:
        'Every branch survives, unmerged work included. Freeing is reversible; only the working copy on disk goes away.',
      tone: 'safe',
      icon: 'branch',
    },
    {
      key: 'refuse',
      label: 'Uncommitted changes refuse instead of being discarded',
      detail:
        'A checkout with unsaved work is left exactly where its author left it and reported back as held. Nothing forces past it.',
      tone: 'safe',
      icon: 'refuse',
    },
  ]
}

const consequenceIcons: Record<ReclaimConsequence['icon'], ReactNode> = {
  disk: <HardDrive size={15} aria-hidden="true" />,
  sessions: <Users size={15} aria-hidden="true" />,
  branch: <GitBranch size={15} aria-hidden="true" />,
  refuse: <ShieldCheck size={15} aria-hidden="true" />,
  rebuild: <RotateCcw size={15} aria-hidden="true" />,
}

/**
 * The one confirm step between a proposal and a checkout leaving the disk.
 * `titles` are the checkouts about to be freed — listed in full, because a
 * count alone cannot be checked against what the operator meant to tick.
 */
export function ReclaimConfirmDialog({
  titles,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  titles: readonly string[] | null
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): JSX.Element {
  const count = titles?.length ?? 0
  const consequences = reclaimFreeConsequences(Math.max(1, count))
  return (
    <AlertDialog open={titles !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="mb-1 flex size-8 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
            <AlertTriangle size={16} aria-hidden="true" />
          </div>
          <AlertDialogTitle>
            Free {count} checkout{count === 1 ? '' : 's'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Only the checkouts you ticked are touched. Here is what that does.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2" data-testid="reclaim-consequences">
          {consequences.map((consequence) => (
            <div
              key={consequence.key}
              className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5"
            >
              <span
                className={
                  consequence.tone === 'cost' ? 'mt-0.5 text-amber-500' : 'mt-0.5 text-success'
                }
              >
                {consequenceIcons[consequence.icon]}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">
                  {consequence.label}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                  {consequence.detail}
                </span>
              </span>
            </div>
          ))}
        </div>
        {titles && titles.length > 0 && (
          <div
            className="flex max-h-32 flex-col gap-0.5 overflow-y-auto"
            data-testid="reclaim-list"
          >
            {titles.map((title) => (
              <span
                key={title}
                className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground"
                title={title}
              >
                {title}
              </span>
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep {count === 1 ? 'it' : 'them'}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || count === 0}
            onClick={onConfirm}
          >
            {busy ? 'Freeing…' : `Free ${count} checkout${count === 1 ? '' : 's'}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
