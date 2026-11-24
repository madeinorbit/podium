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
 * And, beside it, the session's launch terms (POD-6858): the mode token as
 * Podium asked for it and as the agent reports it, and the composer's notices
 * for requirements a launch could not meet.
 *
 * Store, pool and model catalog are stubs (vite.model-chip.config.ts).
 */

import { RuntimeProvider } from '@podium/client-core/react'
import { asSessionId } from '@podium/model/browser'
import { observable } from 'mobx'
import type { JSX } from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { type ModelChipSession, SessionModelChip } from '@/features/chat/SessionModelChip'
import { PostureNotices, SessionModeChip } from '@/features/chat/SessionPosture'
import { ControlHelpPreview } from './control-help-fixtures'
import { chipSessions, configureChip, setConfigureChange } from './model-chip-pool'
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
  const [chip] = useState(() => observable(running(id)))
  chipSessions.set(id, chip)
  return (
    <div className="flex items-center gap-4 py-2" data-row={id}>
      <span className="w-20 text-[12px] text-text-faint">{label}</span>
      <SessionModelChip session={chip} />
    </div>
  )
}

function ModeRow({ label, observedMode }: { label: string; observedMode?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-4 py-2" data-row={`mode-${label}`}>
      <span className="w-20 text-[12px] text-text-faint">{label}</span>
      <span className="flex min-w-0 items-center">
        {/* The read-only face: the launch terms do not need a live driver. */}
        <SessionModelChip session={{ ...running(`mode-${label}`), configureFields: [] }} />
        <SessionModeChip
          session={{
            agentKind: 'claude-code',
            ...(observedMode ? { observedMode } : {}),
            launchPosture: { requestedMode: 'auto', unmet: [] },
          }}
        />
      </span>
    </div>
  )
}

const POSTURE_ONLY = new URLSearchParams(window.location.search).has('posture')
const MODELS_ONLY = new URLSearchParams(window.location.search).has('models')
const HELP = new URLSearchParams(window.location.search).get('help')
const runtime = { commands: { sessions: { configure: configureChip } } } as never

function HarnessRow({
  label,
  id,
  kind,
  model,
}: {
  label: string
  id: string
  kind: string
  model: string
}): JSX.Element {
  const [chip] = useState(() =>
    observable({
      ...running(id),
      agentKind: kind,
      model,
      observedModel: model,
      effort: 'low',
      configureFields: ['model', 'effort'],
    } as ModelChipSession),
  )
  chipSessions.set(id, chip)
  return (
    <div className="flex items-center gap-4 border-b border-border py-4" data-row={id}>
      <span className="w-32 text-sm text-text-dim">{label}</span>
      <SessionModelChip session={chip} />
    </div>
  )
}

function Page(): JSX.Element {
  return (
    <RuntimeProvider runtime={runtime}>
      <ThemeProvider>
        <div className="min-h-screen bg-background p-6 text-foreground">
          {HELP ? (
            <ControlHelpPreview id={HELP} />
          ) : MODELS_ONLY ? (
            <div className="mx-auto max-w-2xl">
              <h1 className="mb-2 text-xl">Headless session controls</h1>
              <p className="mb-6 text-sm text-text-dim">
                Model and effort apply to the next message in the same conversation.
              </p>
              <HarnessRow
                label="Claude Code"
                id="claude"
                kind="claude-code"
                model="claude-opus-5-5"
              />
              <HarnessRow label="Codex" id="codex" kind="codex" model="gpt-5-codex" />
              <HarnessRow label="Grok" id="grok" kind="grok" model="grok-4.5" />
              <HarnessRow
                label="OpenCode 1"
                id="opencode1"
                kind="opencode"
                model="anthropic/claude-sonnet-4"
              />
              <HarnessRow
                label="OpenCode 2"
                id="opencode2"
                kind="opencode"
                model="anthropic/claude-sonnet-4"
              />
              <HarnessRow label="Pi" id="pi" kind="pi" model="fake/model-a" />
              <HarnessRow label="Cursor" id="cursor" kind="cursor" model="sonnet-thinking-low" />
            </div>
          ) : (
            <>
              {/* `?posture` draws the launch terms alone (POD-6858). */}
              {!POSTURE_ONLY && <Row label="idle" id="idle" />}
              {!POSTURE_ONLY && <Row label="pending" id="pending" />}
              <ModeRow label="requested" />
              <ModeRow label="observed" observedMode="default" />
              <div
                className="mt-4 w-[34rem] rounded-[10px] border border-border p-3"
                data-row="notices"
              >
                <PostureNotices
                  session={{
                    agentKind: 'cursor',
                    launchPosture: {
                      requestedMode: null,
                      unmet: [
                        {
                          requirement: 'workspace-trust',
                          reason:
                            'Cursor keeps interactive folder trust in private state that Podium does not write',
                        },
                        {
                          requirement: 'podium-cli',
                          reason:
                            'Cursor takes allow rules only from a settings file shared with every Cursor session, which Podium does not edit',
                        },
                      ],
                    },
                  }}
                />
              </div>
            </>
          )}
        </div>
      </ThemeProvider>
    </RuntimeProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
