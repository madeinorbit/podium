import { effortLabel, issueAgentKind, modelLabel } from '@podium/client-core/agent-models'
import type { SessionView } from '@podium/client-core/session-values'
import type { EffectModel } from '@podium/client-graph/models'
import { awaitEffect } from '@podium/client-graph/write/await-effect'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
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

/**
 * A SESSION'S MODEL · EFFORT CHIP (POD-6264): `Opus 5.5 · High`, in the chat
 * composer where the next message is written, the way the new-task box shows it
 * — without the agent, which a running session cannot change. The session
 * header shows the same chip in the CLI view, which has no composer.
 *
 * TWO FACES, ONE RULE. The daemon reports which fields the live driver's
 * `configure()` accepts (`configureFields`, POD-3087). A running session whose
 * driver lists `model` gets two menus, each drawn as a selector (glyph, value,
 * chevron) so it reads as something that opens; the change is sticky, and the
 * driver says whether it took effect now or from the next turn. Every other
 * session gets the value as plain text whose tooltip says why it cannot change
 * here: the harness reads its model at launch, the session is not running, or
 * the daemon has not said.
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

/** A change's patch, as its record (or this device's queued create) holds it. */
interface ConfigurePatch {
  readonly model?: string
  readonly effort?: string
}

/** The driver's answer on a `session.configure` record (`sessions.configure`'s shape). */
type ConfigureAnswer =
  | { ok: true; effective?: 'now' | 'next-turn' }
  | { reason: string; detail?: string }

/** Say how this device's own change ended: only the device that asked hears
 *  it, once, whether or not the chip is still mounted. */
function tellEnding(change: EffectModel): void {
  const answer = change.result as ConfigureAnswer | undefined
  if (change.status === 'succeeded') {
    toast.success(
      answer && 'ok' in answer && answer.effective === 'now'
        ? 'The running session changed.'
        : 'The change applies from the next turn.',
    )
    return
  }
  if (change.status === 'cancelled') return
  if (answer && 'reason' in answer) {
    toast.error(answer.detail ?? `Could not change the running session (${answer.reason}).`)
    return
  }
  toast.error(
    change.status === 'expired'
      ? 'The change was not made in time; the session runs as before.'
      : (change.error?.message ?? 'Could not change the running session.'),
  )
}

/**
 * The session's latest `session.configure` record (POD-6523), from the pool's
 * own effect models, so every device reads the same progress.
 */
function useConfigureChange(sessionId: ModelChipSession['sessionId']): {
  pool: ReturnType<typeof useWorklistPool>
  change: EffectModel | undefined
} {
  const pool = useWorklistPool()
  return { pool, change: pool?.sessionObject(sessionId).configureChange }
}

const ConfigurableChip = observer(function ConfigurableChip({
  session,
  agentKind,
}: {
  session: ModelChipSession
  agentKind: IssueAgentKind
}): JSX.Element {
  const configureSession = useRuntimeSelector((s) => s.configureSession)
  const sessionId = session.sessionId
  const { pool, change } = useConfigureChange(sessionId)
  // A change this device is still writing, or whose record has not reached
  // the pool yet: its patch paints until the record does.
  const [asked, setAsked] = useState<{ id?: string; patch: ConfigurePatch } | null>(null)
  const recorded = asked?.id !== undefined && change?.id === asked.id
  useEffect(() => {
    if (recorded) setAsked(null)
  }, [recorded])
  // PENDING PAINT: what was asked for, while it waits (POD-6523). A change
  // that ended shows the session's own fields again: a grant wrote them, a
  // refusal left them as they were.
  const pending: ConfigurePatch | undefined =
    asked !== null && !recorded
      ? asked.patch
      : change?.inFlight
        ? (change.input as ConfigurePatch | undefined)
        : undefined
  const model = pending?.model ?? menuModel(session)
  const effort = pending?.effort ?? menuEffort(session)
  // PATCH-shaped: each menu sends only its own field, so the other sticky
  // choice stays as it was.
  const configure = useCallback(
    async (patch: ConfigurePatch) => {
      setAsked({ patch })
      try {
        const id = await configureSession(sessionId, patch)
        setAsked((current) => (current?.patch === patch ? { id, patch } : current))
        // The driver answers on the record, not on the write.
        if (pool) void awaitEffect(pool, id).then(tellEnding)
      } catch {
        setAsked((current) => (current?.patch === patch ? null : current))
        toast.error('Could not change the running session.')
      }
    },
    [sessionId, configureSession, pool],
  )
  return (
    // Glyph · value · chevron on each half (POD-6264): the selector's own
    // grammar, so it never reads as the readout a fixed-at-launch session shows.
    <span
      className="model-chip inline-flex min-w-0 max-w-full items-center gap-0.5"
      data-testid="session-model"
      data-configurable="true"
      // A change still on its way: the menus already show what was asked for.
      data-pending={pending !== undefined ? 'true' : undefined}
      aria-busy={pending !== undefined}
    >
      <ModelPicker
        variant="selector"
        agentKind={agentKind}
        machineId={session.machineId}
        value={model}
        onChange={(next) => {
          if (next !== model) void configure({ model: next })
        }}
      />
      <EffortPicker
        variant="selector"
        agentKind={agentKind}
        machineId={session.machineId}
        model={model}
        value={effort}
        disabled={session.configureFields?.includes('effort') !== true}
        className="shrink-0"
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
