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
        <div className="mx-auto flex min-h-full w-full max-w-[920px] flex-col justify-center px-6 py-10 sm:px-10">
          <div className="mb-6 flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-sm">
            <Sparkles size={18} aria-hidden="true" />
          </div>
          <p className="font-mono text-[10px] font-semibold tracking-[0.13em] text-primary uppercase">
            {eyebrow}
          </p>
          <h1
            id="activation-title"
            className="mt-2 max-w-[18ch] text-[clamp(1.75rem,3vw,2.65rem)] leading-[1.08] font-semibold tracking-[-0.035em] text-foreground"
          >
            {title}
          </h1>
          <p className="mt-3 max-w-[58ch] text-[14px] leading-6 text-muted-foreground">
            {description}
          </p>
          <div className="mt-8">{children}</div>
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
    <article className="max-w-[560px] rounded-xl border border-border bg-background/55 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-secondary text-foreground">
          <FolderGit2 size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-foreground">Add a local project</h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
            Browse a connected machine, scan for Git repositories, and choose what Podium should
            manage.
          </p>
          <Button type="button" className="mt-4" onClick={onSelect}>
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
    <article className="max-w-[560px] rounded-xl border border-primary/30 bg-primary/[0.06] p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Server size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-semibold tracking-[0.11em] text-primary uppercase">
            Recommended for multi-machine Podium
          </p>
          <h2 className="mt-1 text-[14px] font-semibold text-foreground">Add an always-on VPS</h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
            Pair a small server, keep shared Podium state available there, and let this computer
            stay focused on projects and agents.
          </p>
          <Button type="button" className="mt-4" onClick={onSelect}>
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
    <article className="max-w-[560px] rounded-xl border border-border bg-background/55 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-secondary text-foreground">
          <Link2 size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-foreground">Connect to existing Podium</h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
            Open a Podium you already run, or join this machine so it can run projects and agents
            there.
          </p>
          <Button type="button" variant="outline" className="mt-4" onClick={onSelect}>
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
