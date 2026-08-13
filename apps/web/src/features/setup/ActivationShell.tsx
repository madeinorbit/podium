import { ArrowRight, FolderGit2, Link2, Server, Sparkles } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { Button } from '@/components/ui/button'

export function ActivationShell({
  eyebrow,
  title,
  description,
  onExplore,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  onExplore?: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <main className="native-agents-pane relative" aria-labelledby="activation-title">
      <div className="workspace-sheet min-h-0 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col justify-center px-5 py-8 sm:px-10 lg:px-14 lg:py-12">
          <div className="mb-5 flex size-9 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary">
            <Sparkles size={18} aria-hidden="true" />
          </div>
          <p className="font-mono text-xs font-semibold tracking-widest text-primary uppercase">
            {eyebrow}
          </p>
          <h1
            id="activation-title"
            className="mt-2 max-w-[24ch] text-3xl leading-tight font-semibold tracking-tight text-foreground sm:text-4xl"
          >
            {title}
          </h1>
          <p className="mt-4 max-w-[62ch] text-sm leading-6 text-muted-foreground">{description}</p>
          <div className="mt-9">{children}</div>
          {onExplore && (
            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-border/70 pt-5">
              <Button type="button" variant="outline" size="lg" onClick={onExplore}>
                Explore Podium
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Button>
              <p className="text-xs text-muted-foreground">
                Setup stays ready here until you return.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

export function LocalProjectChoice({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <article className="group border-t border-border/80 py-5 first:border-t-0 sm:py-6">
      <div className="flex items-start gap-4">
        <span className="flex size-10 flex-none items-center justify-center rounded-md bg-secondary text-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
          <FolderGit2 size={17} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">Start with a project here</h2>
            <p className="mt-1 max-w-[58ch] text-sm leading-5 text-muted-foreground">
              Choose a repository already on this computer, or clone one from GitHub.
            </p>
          </div>
          <Button type="button" className="self-start sm:self-center" onClick={onSelect}>
            Choose a project
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  )
}

export function AlwaysOnVpsChoice({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <article className="group border-t border-primary/25 bg-primary/[0.035] py-5 sm:px-4 sm:py-6">
      <div className="flex items-start gap-4">
        <span className="flex size-10 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
          <Server size={17} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-semibold tracking-wider text-primary uppercase">
              Best for multiple computers
            </p>
            <h2 className="mt-1 text-base font-semibold text-foreground">
              Create an always-on Podium
            </h2>
            <p className="mt-1 max-w-[58ch] text-sm leading-5 text-muted-foreground">
              Add a new VPS as a machine, then move shared Podium state there so it stays online.
            </p>
          </div>
          <Button type="button" className="self-start sm:self-center" onClick={onSelect}>
            Add a VPS
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  )
}

export function ExistingPodiumChoice({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <article className="group border-t border-border/80 py-5 sm:py-6">
      <div className="flex items-start gap-4">
        <span className="flex size-10 flex-none items-center justify-center rounded-md bg-secondary text-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
          <Link2 size={17} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">
              Connect to a Podium elsewhere
            </h2>
            <p className="mt-1 max-w-[58ch] text-sm leading-5 text-muted-foreground">
              For people who already have a Podium server: open it here, or contribute this
              computer's projects and agents.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="self-start sm:self-center"
            onClick={onSelect}
          >
            View connection options
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  )
}

export function ActivationResumeBar({
  routeLabel,
  onResume,
}: {
  routeLabel: string
  onResume: () => void
}): JSX.Element {
  return (
    <aside
      aria-label="Resume Podium activation"
      className="flex min-h-10 flex-none items-center justify-between gap-3 border-b border-border bg-primary/[0.08] px-4 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Sparkles size={13} className="flex-none text-primary" aria-hidden="true" />
        <span className="font-medium text-foreground">Activation paused</span>
        <span className="truncate text-muted-foreground">Continue at {routeLabel}</span>
      </div>
      <Button type="button" size="sm" onClick={onResume}>
        Resume activation
      </Button>
    </aside>
  )
}
