import { effortLabel, issueAgentKind, modelLabel } from '@podium/client-core/agent-models'
import type { SessionView } from '@podium/client-core/session-values'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useRuntimeActions } from '@/app/keyed-runtime'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { IssueAgentKind } from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import {
  type ConfigurableVerdict,
  canConfigureModel,
  compactModelId,
  menuEffort,
  menuModel,
  readoutEffort,
  readoutModel,
} from '@/lib/session-model'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'
import { useModelCatalog } from '@/lib/use-model-catalog'
import { cn } from '@/lib/utils'

/** The session facts the chip reads. The conversation's shared session model
 *  satisfies it, and the chip reads each field late, under its own name. */
export type ModelChipSession = Pick<
  SessionView,
  | 'sessionId'
  | 'agentKind'
  | 'machineId'
  | 'status'
  | 'configureFields'
  | 'observedModel'
  | 'observedEffort'
  | 'requestedModel'
  | 'requestedEffort'
  | 'model'
  | 'effort'
>

const CHIP =
  'inline-flex h-7 min-w-0 max-w-full items-center rounded-[7px] text-[12px] leading-none text-text-faint'

const CONFIGURE_ACTIONS = ['trpc'] as const

/**
 * A SESSION'S MODEL · EFFORT CHIP (POD-6264): `Opus 5.5 · High`, in the chat
 * composer where the next message is written, the way the new-task box shows it
 * — without the agent, which a running session cannot change. The session
 * header shows the same chip in the CLI view, which has no composer.
 *
 * TWO FACES, ONE RULE. The daemon reports which fields the live driver's
 * `configure()` accepts (`configureFields`, POD-3087). A running session whose
 * driver lists `model` gets two menus; the change is sticky, and the driver says
 * whether it took effect now or from the next turn. Every other session gets the
 * same words as a readout whose tooltip says why it cannot change here: the
 * harness reads its model at launch, the session is not running, or the daemon
 * has not said.
 */
export const SessionModelChip = observer(function SessionModelChip({
  session,
}: {
  session: ModelChipSession | undefined
}): JSX.Element | null {
  const agentKind = issueAgentKind(session?.agentKind)
  if (!session || !agentKind) return null
  const verdict = canConfigureModel(session)
  if (verdict === 'yes' && session.status === 'live') {
    return <ConfigurableChip session={session} agentKind={agentKind} />
  }
  return <ReadoutChip session={session} agentKind={agentKind} verdict={verdict} />
})

const ConfigurableChip = observer(function ConfigurableChip({
  session,
  agentKind,
}: {
  session: ModelChipSession
  agentKind: IssueAgentKind
}): JSX.Element {
  const { trpc } = useRuntimeActions(CONFIGURE_ACTIONS)
  const sessionId = session.sessionId
  const model = menuModel(session)
  const effort = menuEffort(session)
  // PATCH-shaped: each menu sends only its own field, so the other sticky
  // choice stays as it was.
  const configure = useCallback(
    async (patch: { model?: string; effort?: string }) => {
      try {
        const result = await trpc.sessions.configure.mutate({ sessionId, ...patch })
        if ('ok' in result) {
          toast.success(
            result.effective === 'next-turn'
              ? 'The change applies from the next turn.'
              : 'The running session changed.',
          )
          return
        }
        toast.error(result.detail ?? `Could not change the running session (${result.reason}).`)
      } catch {
        toast.error('Could not change the running session.')
      }
    },
    [sessionId, trpc],
  )
  return (
    <span className={CHIP} data-testid="session-model" data-configurable="true">
      <ModelPicker
        variant="inline"
        agentKind={agentKind}
        machineId={session.machineId}
        value={model}
        className="h-7 pr-1 pl-2 hover:text-text-strong"
        onChange={(next) => {
          if (next !== model) void configure({ model: next })
        }}
      />
      <span aria-hidden="true">·</span>
      <EffortPicker
        variant="inline"
        agentKind={agentKind}
        machineId={session.machineId}
        model={model}
        value={effort}
        disabled={session.configureFields?.includes('effort') !== true}
        className="h-7 pr-2 pl-1 enabled:hover:text-text-strong"
        onChange={(next) => {
          if (next !== effort) void configure({ effort: next })
        }}
      />
    </span>
  )
})

const ReadoutChip = observer(function ReadoutChip({
  session,
  agentKind,
  verdict,
}: {
  session: ModelChipSession
  agentKind: IssueAgentKind
  verdict: ConfigurableVerdict
}): JSX.Element | null {
  const live = useModelCatalog(session.machineId)[agentKind]
  const { served } = useHarnessDescriptors(session.machineId)
  const raw = readoutModel(session)
  const rawEffort = readoutEffort(session)
  if (!raw && !rawEffort) return null
  const listed = raw ? modelLabel(agentKind, raw, live, served) : undefined
  // Not in the machine's catalog: still a name, not an id.
  const model = raw && listed === raw ? compactModelId(raw) : listed
  const effort = rawEffort ? effortLabel(agentKind, rawEffort) : undefined
  const text = [model, effort].filter(Boolean).join(' · ')
  const why = readoutReason(session, verdict)
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            // A button so the reason can be reached by keyboard; it has no press.
            <button
              type="button"
              className={cn(
                CHIP,
                'model-token cursor-default px-2 focus-visible:outline-2 focus-visible:outline-ring',
              )}
              data-testid="session-model"
              data-configurable="false"
              // PROVENANCE (POD-413): a value not yet seen in the transcript
              // wears the dotted rule, the typographic mark for provisional.
              data-provenance={session.observedModel ? 'observed' : 'requested'}
              aria-label={`${text}. ${why}`}
            />
          }
        >
          <span className="model-token-text min-w-0 truncate">{text}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[18rem] text-left">
          {why}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

/** Why this session's model cannot be changed from here: where the shown value
 *  comes from, then what stops the change. The harness owns model selection;
 *  Podium reports it. */
export function readoutReason(
  session: Pick<ModelChipSession, 'observedModel' | 'requestedModel'>,
  verdict: ConfigurableVerdict,
): string {
  const provenance = session.observedModel
    ? 'The model this agent is running, read from its transcript.'
    : session.requestedModel
      ? 'Requested on the running session; it applies from the next message.'
      : 'Requested at launch; not yet seen in the transcript.'
  const capability =
    verdict === 'no'
      ? 'This harness takes its model and effort at launch, so they cannot change mid-conversation. Start a new session to use another.'
      : verdict === 'yes'
        ? 'The session is not running. Wake it to change its model or effort.'
        : // Unknown is said as unknown: the daemon has not reported this
          // session's driver, and claiming either answer would be invented.
          'This session has not reported whether its model can change while it runs.'
  return `${provenance} ${capability}`
}
