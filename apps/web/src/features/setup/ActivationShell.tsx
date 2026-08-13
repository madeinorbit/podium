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
          <div className="mb-5 flex size-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <Sparkles size={18} aria-hidden="true" />
          </div>
          <p className="font-mono text-[10px] font-semibold tracking-[0.13em] text-primary uppercase">
            {eyebrow}
          </p>
          <h1
            id="activation-title"
            className="mt-2 max-w-[24ch] text-[clamp(1.75rem,3.4vw,3.25rem)] leading-[1.03] font-semibold tracking-[-0.045em] text-foreground"
          >
            {title}
          </h1>
          <p className="mt-4 max-w-[62ch] text-[13px] leading-6 text-muted-foreground">
            {description}
          </p>
          <div className="mt-9">{children}</div>
          {onExplore && (
            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-border/70 pt-5">
              <Button type="button" variant="outline" size="lg" onClick={onExplore}>
                Explore Podium
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Button>
              <p className="text-[12px] text-muted-foreground">
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
      <div className="flex items-start gap-4 sm:items-center">
        <span className="flex size-10 flex-none items-center justify-center rounded-lg bg-secondary text-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
          <FolderGit2 size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Add a local project</h2>
          <p className="mt-1 max-w-[58ch] text-[13px] leading-5 text-muted-foreground">
            Browse a connected machine, scan for Git repositories, and choose what Podium should
            manage.
          </p>
          <Button type="button" className="mt-3 sm:mt-0 sm:ml-auto" onClick={onSelect}>
            Find local projects
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
      <div className="flex items-start gap-4 sm:items-center">
        <span className="flex size-10 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Server size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-semibold tracking-[0.11em] text-primary uppercase">
            Recommended for multi-machine Podium
          </p>
          <h2 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-foreground">Add an always-on VPS</h2>
          <p className="mt-1 max-w-[58ch] text-[13px] leading-5 text-muted-foreground">
            Pair a small server, keep shared Podium state available there, and let this computer
            stay focused on projects and agents.
          </p>
          <Button type="button" className="mt-3 sm:mt-0 sm:ml-auto" onClick={onSelect}>
            Set up a VPS
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
      <div className="flex items-start gap-4 sm:items-center">
        <span className="flex size-10 flex-none items-center justify-center rounded-lg bg-secondary text-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
          <Link2 size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Connect to existing Podium</h2>
          <p className="mt-1 max-w-[58ch] text-[13px] leading-5 text-muted-foreground">
            Open a Podium you already run, or join this machine so it can run projects and agents
            there.
          </p>
          <Button type="button" variant="outline" className="mt-3 sm:mt-0 sm:ml-auto" onClick={onSelect}>
            Connect
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
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
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
