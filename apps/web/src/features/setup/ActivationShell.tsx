import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The frame every setup step is drawn in. Until setup finishes it is the ONLY
 * thing on screen (POD-1174): AppShell renders no sidebars, no dock, no rail and
 * no status strip, and the window bar keeps nothing but its drag region and the
 * platform window buttons. There is deliberately no way out of here — an empty
 * Podium is not a product tour, and "Explore Podium" used to drop people into
 * one and let them conclude it was broken.
 */
export function ActivationShell({
  eyebrow,
  title,
  description,
  icon,
  contentClassName,
  frameClassName,
  descriptionClassName,
  children,
}: {
  eyebrow: string
  title: string
  description: ReactNode
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
        </div>
      </div>
    </main>
  )
}

/**
 * One answer to the question the step asks. The whole card is the target — the
 * button's `::after` covers it — so the action label never has to repeat the
 * heading, and the heading stays a real heading instead of illegal flow content
 * inside a `<button>`.
 */
export function ActivationChoice({
  icon,
  title,
  badge,
  badgeLit = false,
  description,
  action,
  note,
  primary = false,
  onSelect,
}: {
  icon: ReactNode
  title: string
  badge?: string
  badgeLit?: boolean
  description: ReactNode
  action: string
  note?: ReactNode
  primary?: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <article className="group relative flex flex-col rounded-[13px] bg-[#1b1e24] p-5 shadow-[inset_0_0_0_1px_#2f343d] transition-colors hover:bg-[#1e2128] hover:shadow-[inset_0_0_0_1px_#454b56]">
      <span
        className="flex size-9 flex-none items-center justify-center rounded-[9px] bg-[#22262d] text-[#d7dae0] shadow-[inset_0_0_0_1px_#333842] [&_svg]:size-[19px]"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="mt-[18px] flex flex-wrap items-center gap-2.5">
        <h2 className="text-[15px] leading-none font-semibold text-[#f2f3f5]">{title}</h2>
        {badge && (
          <span
            className={cn(
              // At the 10.5px floor, with a min height rather than a fixed one
              // so a badge that wraps on a narrow column stays inside its pill
              // (POD-1157).
              'shell-type-micro inline-flex min-h-[19px] items-center rounded-[5px] bg-[#2b2f37] px-2 py-[2px] font-mono tracking-[0.14em] uppercase',
              badgeLit ? 'text-[#e3ba52]' : 'text-[#a8adb6]',
            )}
          >
            {badge}
          </span>
        )}
      </div>
      <p className="mt-2 text-[13px] leading-[1.6] text-[#9ba1ab] text-wrap-pretty">
        {description}
      </p>
      {note}
      <span className="min-h-[18px] flex-1" aria-hidden="true" />
      <button
        type="button"
        data-pressable
        onClick={onSelect}
        className={cn(
          'mt-[18px] inline-flex h-[34px] self-start items-center gap-2 rounded-[9px] px-[15px] text-[13px] leading-none font-semibold transition-colors after:absolute after:inset-0 after:rounded-[13px] after:content-[""] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52]',
          primary
            ? 'bg-[#e3ba52] text-[#1a1408] group-hover:bg-[#efc95f]'
            : 'text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56] group-hover:bg-white/[0.04]',
        )}
      >
        {action}
        <ArrowRight
          size={16}
          className={primary ? undefined : 'text-[#9ba1ab]'}
          aria-hidden="true"
        />
      </button>
    </article>
  )
}

/** A limit worth knowing before the choice, not after it. Quiet on purpose. */
export function ActivationChoiceNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="mt-3.5 border-t border-[#272b33] pt-3.5 text-[12.5px] leading-[1.5] text-[#8a9099]">
      {children}
    </p>
  )
}

/** Back goes exactly one step up, on every screen that has one above it. */
export function ActivationBack({
  label = 'Back',
  disabled = false,
  onBack,
}: {
  label?: string
  disabled?: boolean
  onBack: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-pressable
      onClick={onBack}
      disabled={disabled}
      className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] transition-colors hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52] disabled:opacity-50"
    >
      <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
      {label}
    </button>
  )
}
