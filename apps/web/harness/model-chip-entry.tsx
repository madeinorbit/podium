/**
 * THE MODEL CHIP WHILE A CHANGE IS ON ITS WAY, PHOTOGRAPHED (POD-6523).
 *
 * A model or effort change is a `session.configure` effect record. While it
 * waits for the driver, the chip's menus show what was asked for (from this
 * device's write, then from the record), marked pending. This mounts the
 * shipping `SessionModelChip` against the real stylesheet:
 *
 *   idle      the running session as it is: Opus 5.5 · High
 *   pending   a record asking for Sonnet 5.5 · Low, not yet answered
 *
 * Store, pool and model catalog are stubs (vite.model-chip.config.ts).
 */
import { asSessionId } from '@podium/model/browser'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { type ModelChipSession, SessionModelChip } from '@/features/chat/SessionModelChip'
import { setConfigureChange } from './model-chip-pool'
import '@/index.css'
import '@/styles.css'

const running = (id: string): ModelChipSession =>
  ({
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    status: 'live',
    configureFields: ['model', 'effort'],
    observedModel: 'claude-opus-5-5',
    effort: 'high',
    model: 'claude-opus-5-5',
  }) as ModelChipSession

setConfigureChange('pending', {
  id: 'eff_harness_pending',
  kind: 'session.configure',
  status: 'pending',
  inFlight: true,
  input: { model: 'claude-sonnet-5-5', effort: 'low' },
  createdAt: '2026-11-06T12:00:00.000Z',
})

function Row({ label, id }: { label: string; id: string }): JSX.Element {
  const chip = running(id)
  return (
    <div className="flex items-center gap-4 py-2" data-row={id}>
      <span className="w-20 text-[12px] text-text-faint">{label}</span>
      <SessionModelChip session={chip} />
    </div>
  )
}

function Page(): JSX.Element {
  return (
    <ThemeProvider>
      <div className="min-h-screen bg-background p-6 text-foreground">
        <Row label="idle" id="idle" />
        <Row label="pending" id="pending" />
      </div>
    </ThemeProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
