import { ArrowRight, FolderGit2, Link2, Server, Sparkles } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ActivationShell({
  eyebrow,
  title,
  description,
  onExplore,
  icon,
  contentClassName,
  frameClassName,
  descriptionClassName,
  children,
}: {
  eyebrow: string
  title: string
  description: ReactNode
  onExplore?: () => void
  icon?: ReactNode
  contentClassName?: string
  frameClassName?: string
  descriptionClassName?: string
  children: ReactNode
}): JSX.Element {
  return (
    <main
      className="native-agents-pane relative min-h-0 min-w-0 overflow-hidden"
      aria-labelledby="activation-title"
    >
      <div
        data-activation-scroll
        className="workspace-sheet min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div
          className={cn(
            'mx-auto flex min-h-full w-full max-w-[1180px] flex-col px-6 pt-10 pb-12 font-sans sm:px-12 sm:pt-14 sm:pb-14 lg:px-[72px] lg:pt-16 lg:pb-14',
            frameClassName,
          )}
        >
          <div className="flex size-10 flex-none items-center justify-center rounded-[11px] bg-[#2b2f37] text-[#e3ba52] shadow-[inset_0_0_0_1px_#3a4049] [&_svg]:size-[21px]">
            {icon ?? <Sparkles aria-hidden="true" />}
          </div>
          <p className="mt-[22px] font-mono text-[10px] leading-none font-semibold tracking-[0.22em] text-[#e3ba52] uppercase">
            {eyebrow}
          </p>
          <h1
            id="activation-title"
            className="mt-3.5 max-w-[780px] text-[clamp(28px,3.2vw,36px)] leading-[1.12] font-semibold tracking-[-0.024em] text-[#f2f3f5] text-wrap-pretty"
          >
            {title}
          </h1>
          <p
            className={cn(
              'mt-3.5 max-w-[680px] text-[14.5px] leading-[1.6] text-[#9ba1ab] text-wrap-pretty',
              descriptionClassName,
            )}
          >
            {description}
          </p>
          <div className={cn('mt-11', contentClassName)}>{children}</div>
          {onExplore && (
            <div className="mt-10 flex flex-wrap items-center gap-3.5 border-t border-[#363b45] pt-[22px]">
              <button
                type="button"
                onClick={onExplore}
                className="inline-flex h-8 items-center gap-2 rounded-[9px] px-[13px] text-[13px] leading-none font-semibold text-[#e6e8ec] shadow-[inset_0_0_0_1px_#333842] transition-colors hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52]"
              >
                Explore Podium
                <ArrowRight size={15} className="text-[#9ba1ab]" aria-hidden="true" />
              </button>
              <p className="text-[12.5px] leading-none text-[#6f757f]">
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
    <article className="flex items-center gap-4 px-5 py-[19px] max-md:flex-wrap max-md:[&>button:last-child]:ml-[52px] max-md:[&>button:last-child]:w-[calc(100%-52px)]">
      <span className="flex size-9 flex-none items-center justify-center rounded-[9px] bg-[#22262d] text-[#d7dae0] shadow-[inset_0_0_0_1px_#333842]">
        <FolderGit2 size={19} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-[15px] leading-none font-semibold text-[#f2f3f5]">
            Start with a project here
          </h2>
          <span className="inline-flex h-[19px] items-center rounded-[5px] bg-[#2b2f37] px-2 font-mono text-[9px] leading-none tracking-[0.14em] text-[#e3ba52] uppercase">
            Simplest
          </span>
        </div>
        <p className="mt-[5px] text-[13px] leading-[1.55] text-[#9ba1ab]">
          Choose a repository already on this computer, or clone one from GitHub.
        </p>
      </div>
      <ActivationRowButton primary onClick={onSelect}>
        Choose a project
      </ActivationRowButton>
    </article>
  )
}

export function AlwaysOnVpsChoice({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <article className="flex items-center gap-4 border-t border-[#272b33] px-5 py-[19px] max-md:flex-wrap max-md:[&>button:last-child]:ml-[52px] max-md:[&>button:last-child]:w-[calc(100%-52px)]">
      <span className="flex size-9 flex-none items-center justify-center rounded-[9px] bg-[#22262d] text-[#d7dae0] shadow-[inset_0_0_0_1px_#333842]">
        <Server size={19} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-[15px] leading-none font-semibold text-[#f2f3f5]">
            Create an always-on Podium
          </h2>
          <span className="inline-flex h-[19px] items-center rounded-[5px] bg-[#2b2f37] px-2 font-mono text-[9px] leading-none tracking-[0.14em] text-[#a8adb6] uppercase">
            Best for multiple computers
          </span>
        </div>
        <p className="mt-[5px] max-w-[620px] text-[13px] leading-[1.55] text-[#9ba1ab]">
          Add a new VPS as a machine, then move shared Podium state there so agents keep working
          after you close the lid.
        </p>
      </div>
      <ActivationRowButton onClick={onSelect}>Add a VPS</ActivationRowButton>
    </article>
  )
}

export function ExistingPodiumChoice({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <article className="flex items-center gap-4 border-t border-[#272b33] px-5 py-[19px] max-md:flex-wrap max-md:[&>button:last-child]:ml-[52px] max-md:[&>button:last-child]:w-[calc(100%-52px)]">
      <span className="flex size-9 flex-none items-center justify-center rounded-[9px] bg-[#22262d] text-[#8a9099] shadow-[inset_0_0_0_1px_#333842]">
        <Link2 size={19} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] leading-none font-semibold text-[#e6e8ec]">
          Connect to a Podium elsewhere
        </h2>
        <p className="mt-[5px] max-w-[620px] text-[13px] leading-[1.55] text-[#9ba1ab]">
          For people who already have a Podium server: open it here, or contribute this computer's
          projects and agents.
        </p>
      </div>
      <ActivationRowButton tertiary onClick={onSelect}>
        View connection options
      </ActivationRowButton>
    </article>
  )
}

function ActivationRowButton({
  children,
  onClick,
  primary = false,
  tertiary = false,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  tertiary?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-[34px] flex-none items-center gap-2 rounded-[9px] px-[15px] text-[13px] leading-none font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52]',
        primary
          ? 'bg-[#e3ba52] text-[#1a1408] hover:bg-[#efc95f]'
          : tertiary
            ? 'text-[#a8adb6] shadow-[inset_0_0_0_1px_#333842] hover:bg-white/[0.04] hover:text-[#f2f3f5]'
            : 'text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56] hover:bg-white/[0.04]',
      )}
    >
      {children}
      <ArrowRight size={16} className={primary ? undefined : 'text-[#9ba1ab]'} aria-hidden="true" />
    </button>
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
