import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { conciergeThreadId, resolveConciergeRepo } from './concierge'
import { useStore } from './store'

/**
 * The concierge + button (issue #65): the product's front door. One click opens
 * the superagent panel bound to the current repo's concierge intake thread —
 * "tell it what you want", it finds/files the issues. The current repo derives
 * from the selected worktree → focused session's cwd → the only repo; when it's
 * genuinely ambiguous the button becomes a minimal repo picker.
 */
export function ConciergeButton(): JSX.Element {
  const { repos, sessions, selectedWorktree, paneA, setSuperThreadId, setSuperOpen } = useStore()

  const open = (repoPath: string) => {
    setSuperThreadId(conciergeThreadId(repoPath))
    setSuperOpen(true)
  }

  const resolution = resolveConciergeRepo({ repos, selectedWorktree, sessions, paneA })

  const button = (
    <button
      type="button"
      className="flex size-8 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-40"
      title="Concierge — tell it what you want"
      aria-label="Concierge"
      disabled={resolution.kind === 'none'}
      onClick={resolution.kind === 'repo' ? () => open(resolution.repoPath) : undefined}
    >
      <Plus size={17} aria-hidden="true" />
    </button>
  )

  if (resolution.kind !== 'pick') return button

  // Ambiguous context (several repos, none selected): a minimal repo picker.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={button} />
      <DropdownMenuContent align="end">
        {resolution.candidates.map((repo) => (
          <DropdownMenuItem key={repo.path} onClick={() => open(repo.path)}>
            <span className="min-w-0 truncate">{repo.name}</span>
            <span className="ml-2 min-w-0 truncate text-[10px] text-muted-foreground/70">
              {repo.path}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
