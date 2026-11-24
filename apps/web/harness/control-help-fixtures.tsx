/** Shipping controls with public, disposable values for tooltip review. */
import { agentControlHelp, sessionInterfaceHelp } from '@podium/client-core/values'
import { asSessionId } from '@podium/model/browser'
import type { ReactNode } from 'react'
import { type ModelChipSession, SessionModelChip } from '@/features/chat/SessionModelChip'
import { PostureNotices, SessionModeChip } from '@/features/chat/SessionPosture'
import { HelpButton } from '@/lib/ControlHelp'
import { AllConnectorsModelPicker, EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { setConfigureChange } from './model-chip-pool'

interface HelpCase {
  id: string
  label: string
  control: ReactNode
  target?: string
  click?: boolean
  catalog?: string
}

const MODEL = 'claude-opus-5-5'
const base: ModelChipSession = {
  sessionId: asSessionId('help-session'),
  agentKind: 'claude-code',
  status: 'live',
  model: MODEL,
  effort: 'high',
  configureFields: [],
}
const modelCase = (id: string, label: string, fields: Partial<ModelChipSession>): HelpCase => ({
  id,
  label,
  control: <SessionModelChip session={{ ...base, ...fields }} />,
  target: '[data-testid="session-model"]',
})
const noop = () => {}

setConfigureChange('help-pending', {
  id: 'eff_help_pending',
  kind: 'session.configure',
  status: 'pending',
  inFlight: true,
  input: { model: 'claude-sonnet-5-5', effort: 'low' },
  createdAt: '2026-11-24T09:00:00.000Z',
})

export const controlHelpCases: HelpCase[] = [
  modelCase('model-confirmed', 'Model and thinking time · Confirmed', {
    observedModel: base.model,
    observedEffort: 'high',
  }),
  modelCase('model-selected', 'Model and thinking time · Selected at start', {}),
  modelCase('model-next-message', 'Model and thinking time · Selected for the next message', {
    requestedModel: 'claude-sonnet-5-5',
    requestedEffort: 'low',
  }),
  modelCase('model-unconfirmed-thinking', 'Model confirmed · Thinking time still unconfirmed', {
    observedModel: base.model,
    requestedEffort: 'low',
  }),
  modelCase('model-unconfirmed-model', 'Thinking time confirmed · Model still unconfirmed', {
    observedEffort: 'low',
  }),
  modelCase('model-sleeping', 'Model and thinking time · Sleeping session', {
    configureFields: ['model', 'effort'],
    status: 'hibernated',
    model: 'auto',
    effort: 'auto',
  }),
  modelCase('model-unavailable', 'Model and thinking time · Changes unavailable', {
    configureFields: undefined,
    observedModel: base.model,
    observedEffort: 'high',
  }),
  ...(['model', 'effort'] as const).flatMap((field) => [
    {
      id: `${field}-changeable`,
      label: `${field === 'model' ? 'Model' : 'Thinking time'} · Next message`,
      control: <SessionModelChip session={{ ...base, configureFields: ['model', 'effort'] }} />,
      target: `button[aria-label="${field === 'model' ? 'Model' : 'Effort'}"]`,
    },
    {
      id: `${field}-pending`,
      label: `${field === 'model' ? 'Model' : 'Thinking time'} · Change in progress`,
      control: (
        <SessionModelChip
          session={{
            ...base,
            sessionId: asSessionId('help-pending'),
            configureFields: ['model', 'effort'],
          }}
        />
      ),
      target: `button[aria-label="${field === 'model' ? 'Model' : 'Effort'}"]`,
    },
  ]),
  {
    id: 'effort-fixed',
    label: 'Thinking time · Fixed for this session',
    control: <SessionModelChip session={{ ...base, configureFields: ['model'] }} />,
    target: 'button[aria-label="Effort"]',
  },
  ...['auto', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
    (value) => ({
      id: `thinking-${value}`,
      label: `Thinking time · ${value}`,
      control: <EffortPicker agentKind="claude-code" model={MODEL} value={value} onChange={noop} />,
      target: 'button[aria-label="Effort"]',
    }),
  ),
  {
    id: 'effort-choose-model',
    label: 'Thinking time · Choose a model first',
    control: <EffortPicker agentKind="claude-code" model="auto" value="auto" onChange={noop} />,
    target: 'button[aria-label="Effort"]',
  },
  {
    id: 'effort-no-levels',
    label: 'Thinking time · No available choices',
    control: (
      <EffortPicker
        agentKind="claude-code"
        model="model-without-levels"
        value="high"
        onChange={noop}
      />
    ),
    target: 'button[aria-label="Effort"]',
  },
  ...['auto', MODEL].map((value) => ({
    id: value === 'auto' ? 'new-model-auto' : 'new-model-selected',
    label: 'Model · New task',
    control: <ModelPicker agentKind="claude-code" value={value} onChange={noop} />,
    target: 'button[aria-label="Model"]',
  })),
  ...['auto', MODEL].map((value) => ({
    id: value === 'auto' ? 'assistant-model-auto' : 'assistant-model-selected',
    label: 'Assistant · Next message',
    control: <AllConnectorsModelPicker agentKind="claude-code" value={value} onChange={noop} />,
    target: 'button[aria-label="Model"]',
  })),
  ...['unavailable', 'loading'].map((catalog) => ({
    id: `model-catalog-${catalog}`,
    label: 'Model choices',
    catalog,
    control: <ModelPicker agentKind="claude-code" value="auto" onChange={noop} />,
    target: 'button[aria-label="Model"]',
    click: true,
  })),
  ...(
    [
      [
        'claude-code',
        ['default', 'manual', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'dontAsk'],
      ],
      ['codex', ['on-request', 'auto-review', 'never']],
      ['grok', ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']],
      ['opencode', ['ask', 'auto']],
      ['cursor', ['allowlist', 'auto-review', 'plan', 'ask']],
      ['antigravity', ['default', 'auto', 'accept-edits', 'always-proceed', 'plan']],
    ] as const
  ).flatMap(([kind, modes]) =>
    modes.map((mode) => ({
      id: `permissions-${kind}-${mode}`,
      label: `${kind} · Permissions`,
      control: <SessionModeChip session={{ agentKind: kind, observedMode: mode }} />,
      target: '[data-testid="session-mode"]',
    })),
  ),
  {
    id: 'permissions-requested',
    label: 'Permissions · Requested, not yet confirmed',
    control: (
      <SessionModeChip
        session={{ agentKind: 'claude-code', launchPosture: { requestedMode: 'auto', unmet: [] } }}
      />
    ),
    target: '[data-testid="session-mode"]',
  },
  {
    id: 'permissions-unknown',
    label: 'Permissions · Unknown mode',
    control: <SessionModeChip session={{ agentKind: 'codex', observedMode: 'new-mode' }} />,
    target: '[data-testid="session-mode"]',
  },
  ...['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'pi', 'antigravity', 'shell'].map(
    (kind) => ({
      id: `agent-${kind}`,
      label: 'Agent · New task',
      control: (
        <HelpButton
          className="h-7 rounded px-2 text-sm text-text-dim"
          help={agentControlHelp(kind)}
          aria-label="Agent"
        >
          {kind}
        </HelpButton>
      ),
      target: 'button[aria-label="Agent"]',
    }),
  ),
  ...[true, false].map((terminal) => ({
    id: `interface-${terminal ? 'terminal' : 'chat'}`,
    label: 'Session interface · New task',
    control: (
      <HelpButton
        className="h-7 rounded px-2 text-sm text-text-dim"
        help={sessionInterfaceHelp(terminal)}
        aria-label="Session interface"
      >
        {terminal ? 'Terminal' : 'Chat'}
      </HelpButton>
    ),
    target: 'button[aria-label="Session interface"]',
  })),
  {
    id: 'startup-notices',
    label: 'When a session needs attention',
    control: (
      <PostureNotices
        session={{
          agentKind: 'cursor',
          launchPosture: {
            requestedMode: null,
            unmet: (
              [
                'workspace-trust',
                'podium-cli',
                'autonomy',
                'quiet-start',
                'podium-material',
              ] as const
            ).map((requirement) => ({
              requirement,
              reason: 'Adapter diagnostic omitted from user-facing copy.',
            })),
          },
        }}
      />
    ),
  },
  {
    id: 'pi-approval-notice',
    label: 'Pi · Approval prompts unavailable',
    control: (
      <PostureNotices
        session={{
          agentKind: 'pi',
          launchPosture: {
            requestedMode: null,
            unmet: [{ requirement: 'autonomy', reason: 'Pi has no approval gate.' }],
          },
        }}
      />
    ),
  },
]

export function ControlHelpPreview({ id }: { id: string }) {
  const example = controlHelpCases.find((entry) => entry.id === id)
  if (!example) throw new Error(`Unknown help example: ${id}`)
  return (
    <>
      <script id="control-help-cases" type="application/json">
        {JSON.stringify(controlHelpCases.map(({ control: _control, ...entry }) => entry))}
      </script>
      <main
        className="mx-auto flex min-h-[500px] max-w-3xl flex-col justify-center gap-4"
        data-help-case={example.id}
      >
        <h1 className="text-base text-text-dim">{example.label}</h1>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-5 text-sm text-text-faint">What would you like to work on?</div>
          <div className="flex min-w-0 items-center">{example.control}</div>
        </div>
      </main>
    </>
  )
}
