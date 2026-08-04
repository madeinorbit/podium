import type { MotionPhase } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { PhaseTimer } from './PhaseTimer'
import { StatusBadge, type StatusBadgeKind } from './StatusBadge'
import { usePhaseMorph } from './usePhaseMorph'

const PHASE_LABEL: Record<MotionPhase, string> = {
  queued: 'QUEUED',
  working: 'WORKING',
  waiting: 'WAITING ON YOU',
  done: 'DONE',
}

/**
 * Real-app browser harness for the motion primitives. It is mounted only by
 * app/main.tsx when both `e2e=1` and `motion-demo=1` are present, keeping the
 * verification path connected to the production React components and CSS.
 */
export function MotionDemo(): JSX.Element {
  const [phase, setPhase] = useState<MotionPhase>('queued')
  const [sinceMs, setSinceMs] = useState(() => Date.now())
  const [revision, setRevision] = useState(0)
  const morph = usePhaseMorph(phase)

  const transition = (next: MotionPhase): void => {
    setSinceMs(Date.now())
    setPhase(next)
  }
  const badgeKind: StatusBadgeKind | null =
    phase === 'working'
      ? 'spinner'
      : phase === 'waiting'
        ? 'count'
        : phase === 'done'
          ? 'check'
          : null

  return (
    <main
      aria-label="Motion primitives demo"
      className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground"
    >
      <section className="w-full max-w-[620px] rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text-strong">Motion primitives</h1>
          <output
            data-testid="phase-label"
            className="font-mono text-[9px] tracking-[0.12em] text-muted-foreground"
          >
            {PHASE_LABEL[phase]}
          </output>
          <span data-testid="revision" className="sr-only">
            {revision}
          </span>
        </div>

        <div
          data-testid="motion-row"
          data-phase={phase}
          className={cn(
            'phase-surface flex items-center gap-3 rounded-lg border p-3',
            morph === 'waiting' && 'morph-row-flash',
          )}
          style={{
            background:
              phase === 'waiting'
                ? 'color-mix(in srgb, var(--attention) 10%, transparent)'
                : phase === 'working'
                  ? 'color-mix(in srgb, #8b5cf6 20%, var(--card))'
                  : 'color-mix(in srgb, #8b5cf6 8%, var(--card))',
            borderColor:
              phase === 'waiting'
                ? 'color-mix(in srgb, var(--attention) 45%, transparent)'
                : phase === 'queued'
                  ? 'transparent'
                  : 'rgba(139, 92, 246, 0.5)',
            opacity: phase === 'queued' ? 0.7 : phase === 'done' ? 0.85 : 1,
          }}
        >
          <span
            data-testid="motion-square"
            className={cn(
              'phase-surface relative flex size-[32px] flex-none flex-col items-center justify-center rounded-lg border font-mono text-[7px] font-semibold leading-tight',
              morph === 'working' && 'morph-ignite',
            )}
            style={{
              background: phase === 'queued' ? 'var(--secondary)' : '#8b5cf6',
              borderColor: phase === 'queued' ? 'var(--text-dim)' : '#8b5cf6',
              borderStyle: phase === 'queued' ? 'dashed' : 'solid',
              color: phase === 'queued' ? 'var(--label)' : '#1e0b44',
            }}
          >
            <span>POD</span>
            <span>128</span>
            <StatusBadge kind={badgeKind} count={phase === 'waiting' ? 1 : undefined} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-strong">Token refresh loop</div>
            <div className="text-[11px] text-muted-foreground">
              {phase === 'queued' ? 'queued' : phase === 'working' ? 'computing' : phase}
            </div>
          </div>
          <PhaseTimer
            phase={phase}
            sinceMs={sinceMs}
            totalMs={12_000}
            className="motion-demo-timer"
          />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={() => transition('queued')}>
            Reset
          </button>
          <button type="button" onClick={() => transition('working')}>
            Start work
          </button>
          <button type="button" onClick={() => transition('waiting')}>
            Needs input
          </button>
          <button type="button" onClick={() => transition('done')}>
            Complete
          </button>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Unrelated rerender
          </button>
        </div>
      </section>
    </main>
  )
}
