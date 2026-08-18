import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { shallowEqual } from '@podium/client-core/store'
import type { HarnessAgent, SessionId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { EXAMPLE_USAGE_REPORT_DISPLAY as TELEMETRY_EXAMPLE } from '@podium/telemetry/example'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
} from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SetupLoginTerminalDialog } from '@/app/SetupLoginTerminalDialog'
import { useStoreSelector } from '@/app/store'
import {
  ISSUE_AGENT_KINDS,
  issueAgentIcon,
  issueAgentKind,
  issueAgentLabel,
  type IssueAgentKind,
} from '@/lib/issue-agents'
import { cn } from '@/lib/utils'
import {
  activationAgentIsInstalled,
  activationAgentIsReady,
  activationAgentReadiness,
  activationReadinessCopy,
  type ActivationAgentReadiness,
} from './agent-readiness'
import type { ActivationRoute } from './activation-route'
import { persistFirstTaskDraft, readFirstTaskDraft } from './first-task-draft'
import { SetupError } from './SetupFeedback'
import { ActivationShell } from './ActivationShell'

function setupHint(agent: IssueAgentKind, readiness: ActivationAgentReadiness): string {
  if (agent === 'opencode' && readiness.state === 'logged-out') {
    return 'Installed but not signed in. You can continue now and sign in before you run it.'
  }
  if (readiness.state !== 'missing')
    return activationReadinessCopy(readiness, issueAgentLabel(agent))
  if (agent === 'opencode') {
    return 'Install OpenCode on this machine, then run “opencode auth login”. Podium will detect it automatically.'
  }
  if (agent === 'cursor') {
    return 'Install the Cursor CLI on this machine, then run “cursor-agent login”. Podium will detect it automatically.'
  }
  return activationReadinessCopy(readiness, issueAgentLabel(agent))
}

interface TelemetryStateWire {
  usage: 'absent' | 'on' | 'off'
  crash: 'absent' | 'on' | 'off'
  suppressedBy?: string
}

function TelemetryChoice({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  detail: string
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3.5 border-t border-[#272b33] px-[22px] py-4 hover:bg-white/[0.02]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="sr-only"
      />
      <span
        className={cn(
          'mt-px flex size-5 flex-none items-center justify-center rounded-md',
          checked
            ? 'bg-[#e3ba52] text-[#1a1408]'
            : 'bg-[#22262d] shadow-[inset_0_0_0_1.5px_#454b56]',
        )}
        aria-hidden="true"
      >
        {checked && <Check size={15} />}
      </span>
      <span className="min-w-0">
        <span
          className={`block text-[14.5px] leading-none font-semibold ${checked ? 'text-[#f2f3f5]' : 'text-[#e6e8ec]'}`}
        >
          {title}
        </span>
        <span className="mt-[5px] block text-[13px] leading-[1.5] text-[#9ba1ab]">{detail}</span>
      </span>
    </label>
  )
}

export function FirstTaskActivation({
  route,
  onRouteChange,
  onComplete,
}: {
  route: Extract<ActivationRoute, 'agent' | 'first-task'>
  onRouteChange: (route: ActivationRoute) => void
  onComplete: () => void
}): JSX.Element {
  const { trpc, repos, machines, uiState } = useStoreSelector(
    (store) => ({
      trpc: store.trpc,
      repos: store.repos,
      machines: store.machines,
      uiState: store.uiState,
    }),
    shallowEqual,
  )
  const repoChoices = useMemo(
    () =>
      repos.filter((repo) => repo.kind !== 'worktree').sort((a, b) => a.path.localeCompare(b.path)),
    [repos],
  )
  const [draft, setDraftState] = useState(() =>
    readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY)),
  )
  const [configuredAgent, setConfiguredAgent] = useState<IssueAgentKind | null>(null)
  const [loginBusyAgent, setLoginBusyAgent] = useState<IssueAgentKind | null>(null)
  const [loginSessionId, setLoginSessionId] = useState<SessionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [telemetryState, setTelemetryState] = useState<TelemetryStateWire | null>(null)
  const [telemetryUnavailable, setTelemetryUnavailable] = useState(false)
  const [usageTelemetry, setUsageTelemetry] = useState(false)
  const [crashTelemetry, setCrashTelemetry] = useState(false)
  const [finishBusy, setFinishBusy] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  const setDraft = useCallback(
    (next: typeof draft) => {
      setDraftState(next)
      persistFirstTaskDraft(uiState, next)
    },
    [uiState],
  )

  useEffect(() => {
    let cancelled = false
    void trpc.settings.get
      .query()
      .then((settings) => {
        if (!cancelled) {
          setConfiguredAgent(
            issueAgentKind(resolveRole(settings, 'coding').harness) ?? 'claude-code',
          )
        }
      })
      .catch(() => {
        if (!cancelled) setConfiguredAgent('claude-code')
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  useEffect(() => {
    if (route !== 'first-task' || telemetryState || telemetryUnavailable) return
    let cancelled = false
    void trpc.telemetry.state.query().then(
      (state) => {
        if (cancelled) return
        const next = state as TelemetryStateWire
        setTelemetryState(next)
        setUsageTelemetry(next.usage === 'on' || next.usage === 'absent')
        setCrashTelemetry(next.crash === 'on')
      },
      () => {
        if (!cancelled) setTelemetryUnavailable(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [route, telemetryState, telemetryUnavailable, trpc])

  const selectedRepo = repoChoices.find((repo) => repo.path === draft.repoPath) ?? repoChoices[0]
  useEffect(() => {
    if (!selectedRepo || draft.repoPath === selectedRepo.path) return
    setDraft({ ...draft, repoPath: selectedRepo.path })
  }, [draft, selectedRepo, setDraft])

  const readinessByAgent = useMemo(
    () =>
      Object.fromEntries(
        ISSUE_AGENT_KINDS.map((agent) => [
          agent,
          activationAgentReadiness(selectedRepo, machines, agent),
        ]),
      ) as Record<IssueAgentKind, ActivationAgentReadiness>,
    [machines, selectedRepo],
  )
  const installedAgents = ISSUE_AGENT_KINDS.filter((agent) =>
    activationAgentIsInstalled(readinessByAgent[agent]),
  )
  const readyAgents = installedAgents.filter((agent) =>
    activationAgentIsReady(readinessByAgent[agent]),
  )
  useEffect(() => {
    if (!configuredAgent || draft.agent) return
    const preferred = activationAgentIsReady(readinessByAgent[configuredAgent])
      ? configuredAgent
      : (readyAgents[0] ?? installedAgents[0])
    if (preferred) setDraft({ ...draft, agent: preferred })
  }, [configuredAgent, draft, installedAgents, readinessByAgent, readyAgents, setDraft])

  const openLogin = async (agent: IssueAgentKind): Promise<void> => {
    const machine = readinessByAgent[agent].machine
    if (!machine || loginBusyAgent) return
    setLoginBusyAgent(agent)
    setError(null)
    try {
      const result = await trpc.accounts.login.mutate({
        harness: agent as HarnessAgent,
        machineId: machine.id,
      })
      setLoginSessionId(result.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoginBusyAgent(null)
    }
  }

  if (route === 'first-task') {
    const finish = async (): Promise<void> => {
      if (finishBusy) return
      setFinishBusy(true)
      setFinishError(null)
      try {
        if (telemetryState && !telemetryState.suppressedBy) {
          await trpc.telemetry.set.mutate({
            usage: usageTelemetry ? 'on' : 'off',
            crash: crashTelemetry ? 'on' : 'off',
          })
        }
        onComplete()
      } catch (cause) {
        setFinishError(cause instanceof Error ? cause.message : String(cause))
        setFinishBusy(false)
      }
    }

    return (
      <ActivationShell
        eyebrow="Set up Podium · Ready"
        title="Podium is good to go."
        description="Your project and agents are set up. One optional privacy choice is left, then you can start working."
        icon={<Check aria-hidden="true" />}
        contentClassName="mt-8"
        frameClassName="min-h-[1000px] lg:pt-14 lg:pb-11 [&>div:first-child]:bg-[#2a2718] [&>div:first-child]:shadow-[inset_0_0_0_1px_#4a4324]"
      >
        <section className="overflow-hidden rounded-[13px] bg-[#1b1e24] shadow-[inset_0_0_0_1px_#2f343d]">
          <div className="px-[22px] pt-5 pb-[18px]">
            <h2 className="text-[16px] leading-none font-semibold text-[#f2f3f5]">
              Help improve Podium with anonymous telemetry
            </h2>
            <p className="mt-2 max-w-[800px] text-[13.5px] leading-[1.6] text-[#9ba1ab] text-wrap-pretty">
              Nothing is sent unless you opt in. Podium never includes paths, repository names,
              prompts, code, or other free text, and IP addresses are dropped at ingest.
            </p>
          </div>

          {telemetryState?.suppressedBy ? (
            <div className="border-t border-[#272b33] px-[22px] py-4 text-[13px] text-[#9ba1ab]">
              Telemetry is disabled by {telemetryState.suppressedBy}; no choice is needed here.
            </div>
          ) : telemetryUnavailable ? (
            <div className="border-t border-[#272b33] px-[22px] py-4 text-[13px] text-[#9ba1ab]">
              Telemetry preferences are unavailable right now. You can change them later in Settings
              › Privacy.
            </div>
          ) : telemetryState ? (
            <>
              <TelemetryChoice
                checked={usageTelemetry}
                onChange={setUsageTelemetry}
                title="Send anonymous usage reports"
                detail="One compact report per day about versions, feature counts, and reliability."
              />
              <TelemetryChoice
                checked={crashTelemetry}
                onChange={setCrashTelemetry}
                title="Send scrubbed crash reports"
                detail="Error type and Podium source lines only; error messages and outside frames are dropped."
              />
              <div className="border-t border-[#272b33] bg-[#191c21] px-[22px] pt-[18px] pb-5">
                <div className="flex items-center gap-2.5">
                  <p className="text-[13px] leading-none font-semibold text-[#a8adb6]">
                    Exactly what one usage report contains
                  </p>
                  <span className="h-px flex-1 bg-[#272b33]" aria-hidden="true" />
                </div>
                <pre className="mt-3 max-w-full overflow-x-auto rounded-[10px] bg-[#121417] px-[18px] py-4 font-mono text-[12.5px] leading-[1.85] text-[#b9bec6] shadow-[inset_0_0_0_1px_#272b33]">
                  {TELEMETRY_EXAMPLE}
                </pre>
                <p className="mt-3 text-[13px] leading-[1.5] text-[#8a9099]">
                  Change this anytime in Settings › Privacy, or with{' '}
                  <code className="font-mono text-[12px] text-[#b9bec6]">podium telemetry off</code>
                  .
                </p>
              </div>
            </>
          ) : (
            <div
              className="border-t border-[#272b33] px-[22px] py-4 font-mono text-[12px] text-[#9ba1ab]"
              role="status"
            >
              Loading privacy choices…
            </div>
          )}
        </section>

        {finishError && (
          <div className="mt-3">
            <SetupError>{finishError}</SetupError>
          </div>
        )}

        <div className="mt-[22px] flex items-center gap-3.5">
          <button
            type="button"
            data-pressable
            disabled={finishBusy}
            onClick={() => onRouteChange('agent')}
            className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] disabled:opacity-50"
          >
            <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
            Back to agents
          </button>
          <span className="flex-1" />
          <button
            type="button"
            data-pressable
            disabled={finishBusy || (!telemetryState && !telemetryUnavailable)}
            onClick={() => void finish()}
            className="inline-flex h-[38px] items-center gap-2 rounded-[9px] bg-[#e3ba52] px-[18px] text-[13.5px] leading-none font-semibold text-[#1a1408] hover:bg-[#efc95f] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {finishBusy ? (
              <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
            ) : (
              <>
                <span>Finish setup</span>
                <ArrowRight size={17} aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </ActivationShell>
    )
  }

  const selectedMachine =
    machines.find((machine) => machine.id === selectedRepo?.machineId) ?? machines[0]
  const otherAgents = ISSUE_AGENT_KINDS.filter(
    (agent) => !activationAgentIsReady(readinessByAgent[agent]),
  )
  const copySetupCommand = (agent: IssueAgentKind): void => {
    const command = agent === 'cursor' ? 'cursor-agent login' : 'opencode auth login'
    void navigator.clipboard?.writeText(command)
  }

  const renderAgentRows = (agents: readonly IssueAgentKind[]): JSX.Element[] =>
    agents.map((agent, index) => {
      const readiness = readinessByAgent[agent]
      const ready = activationAgentIsReady(readiness)
      const needsLogin = readiness.state === 'logged-out'
      const setupCommand =
        readiness.state === 'missing' && (agent === 'opencode' || agent === 'cursor')
          ? agent === 'cursor'
            ? 'cursor-agent login'
            : 'opencode auth login'
          : null
      const status = ready ? 'Ready' : needsLogin ? 'Sign-in optional' : 'Waiting'

      return (
        <div
          key={agent}
          className={cn(
            'flex items-center gap-[15px] px-5 py-4 max-sm:flex-wrap',
            index < agents.length - 1 && 'border-b border-[#272b33]',
          )}
        >
          <div
            className={cn(
              'flex size-9 flex-none items-center justify-center rounded-[9px] bg-[#22262d] shadow-[inset_0_0_0_1px_#333842]',
              agent === 'claude-code'
                ? '[&_svg]:text-[#d97757]'
                : ready
                  ? '[&_svg]:text-[#e6e8ec]'
                  : '[&_svg]:text-[#8a9099]',
            )}
          >
            {issueAgentIcon(agent, agent === 'claude-code' ? 18 : 17)}
          </div>

          {/* basis-full below `sm` sends the action button to its own line
              instead of squeezing this column to ~150px, where the install hint
              and its command pill collided with the button (POD-1200). */}
          <div className="min-w-0 flex-1 max-sm:basis-full">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'truncate text-[15px] leading-none font-semibold',
                  ready ? 'text-[#f2f3f5]' : 'text-[#d7dae0]',
                )}
              >
                {issueAgentLabel(agent)}
              </span>
            </div>
            {agent === 'cursor' && setupCommand ? (
              <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[13px] leading-[1.45] text-[#9ba1ab]">
                <span>Install the CLI, then run</span>
                {/* No fixed height, and never broken across lines: on a phone
                    this column is ~150px wide, and a 21px pill with a command
                    wrapped onto three lines inside it put the text outside its
                    own box (POD-1200). It wraps as a whole instead. */}
                <code className="inline-flex items-center rounded-[5px] bg-[#22262d] px-2 py-[3px] font-mono text-[12px] leading-none whitespace-nowrap text-[#c3c8d0] shadow-[inset_0_0_0_1px_#333842]">
                  {setupCommand}
                </code>
                <span>— Podium detects it.</span>
              </p>
            ) : (
              /* One line on a desktop row, wrapped on a phone: the column is the
                 full width there now, so ellipsising a sentence that fits is
                 just hiding the instruction it carries (POD-1200). */
              <p className="mt-[5px] truncate text-[13px] leading-[1.45] text-[#9ba1ab] max-sm:whitespace-normal">
                {setupHint(agent, readiness)}
              </p>
            )}
          </div>

          <span
            className={cn(
              'hidden flex-none items-center gap-[7px] text-[12.5px] leading-none sm:inline-flex',
              ready ? 'text-[#69c48a]' : needsLogin ? 'text-[#a8adb6]' : 'text-[#8a9099]',
            )}
          >
            {ready ? (
              <CheckCircle2 size={16} aria-hidden="true" />
            ) : needsLogin ? (
              <CircleAlert size={16} className="text-[#8a9099]" aria-hidden="true" />
            ) : (
              <Clock3 size={16} aria-hidden="true" />
            )}
            {status}
          </span>

          {needsLogin ? (
            <button
              type="button"
              data-pressable
              disabled={loginBusyAgent !== null}
              onClick={() => void openLogin(agent)}
              className="inline-flex h-[31px] w-32 flex-none items-center justify-center gap-2 rounded-[9px] text-[12.5px] leading-none font-semibold text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56] hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52] disabled:opacity-50"
            >
              {loginBusyAgent === agent ? (
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <>
                  Sign in
                  <ArrowRight size={14} aria-hidden="true" />
                </>
              )}
            </button>
          ) : setupCommand ? (
            <button
              type="button"
              data-pressable
              onClick={() => copySetupCommand(agent)}
              className="h-[31px] w-32 flex-none rounded-[9px] text-[12.5px] leading-none text-[#a8adb6] shadow-[inset_0_0_0_1px_#333842] hover:bg-white/[0.04] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-[#e3ba52]"
            >
              Copy command
            </button>
          ) : (
            <span className="hidden w-32 flex-none sm:block" aria-hidden="true" />
          )}
        </div>
      )
    })

  return (
    <ActivationShell
      eyebrow="Set up Podium · Agents"
      title="Set up your agents."
      description={
        <>
          Podium runs whichever coding agents are installed on{' '}
          <code className="font-mono text-[13.5px] text-[#c3c8d0]">
            {selectedMachine?.hostname ?? selectedMachine?.name ?? 'this machine'}
          </code>
          . Installed agents are enough to continue. Sign in now or later, before you run one.
        </>
      }
      contentClassName="mt-7"
    >
      {/* TWO CARDS, ONE LABEL (POD-1225). The not-ready group lost its "Needs
          one step" band and its count: every row in it already names its own
          status and the step it is waiting on, so the header was a number put on
          work nobody has to do yet. With both groups in one card the surviving
          "Ready to use" band would then appear to head the whole list — so the
          groups separate by card instead, which says the same thing without a
          second row of chrome. */}
      <div className="flex flex-col gap-3">
        {readyAgents.length > 0 && (
          <div className="overflow-hidden rounded-[13px] bg-[#1b1e24] shadow-[inset_0_0_0_1px_#2f343d]">
            <div className="flex items-center gap-2.5 border-b border-[#272b33] bg-[#1f2329] px-5 py-2.5 text-[12px] leading-none font-semibold text-[#a8adb6]">
              <span className="flex-1">Ready to use</span>
              <span className="text-[#69c48a]">{readyAgents.length}</span>
            </div>
            {renderAgentRows(readyAgents)}
          </div>
        )}
        {otherAgents.length > 0 && (
          <div className="overflow-hidden rounded-[13px] bg-[#1b1e24] shadow-[inset_0_0_0_1px_#2f343d]">
            {renderAgentRows(otherAgents)}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3">
          <SetupError>{error}</SetupError>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3.5">
        <button
          type="button"
          data-pressable
          onClick={() => onRouteChange('local-project')}
          className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52]"
        >
          <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
          Change project
        </button>
        <span className="flex-1" />
        <button
          type="button"
          data-pressable
          disabled={installedAgents.length === 0}
          onClick={() => onRouteChange('first-task')}
          className="inline-flex h-[34px] items-center gap-2 rounded-[9px] bg-[#e3ba52] px-[15px] text-[13px] leading-none font-semibold text-[#1a1408] hover:bg-[#efc95f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2f3f5] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      <SetupLoginTerminalDialog
        sessionId={loginSessionId}
        onClose={() => setLoginSessionId(null)}
      />
    </ActivationShell>
  )
}
