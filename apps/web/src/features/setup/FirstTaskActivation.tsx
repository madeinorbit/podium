import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import {
  activationAgentIsInstalled,
  activationAgentIsReady,
  activationAgentReadiness,
  activationReadinessCopy,
} from '@podium/client-core/values'
import { observer } from '@podium/client-graph/react'
import type { HarnessAgent, SessionId } from '@podium/model'
import { HOST_REPOS, machinesFor } from '@podium/model'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CircleAlert, LoaderCircle } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { SetupLoginTerminalDialog } from '@/app/SetupLoginTerminalDialog'
import { serverConfig } from '@/app/trpc'
import { MachineHarnessRow } from '@/features/settings/machine-harnesses'
import { useSettingsCatalog, useSettingsDraft } from '@/features/settings/readers'
import { useSettingsClient } from '@/features/settings/stable-access'
import { useResolvedDescriptors } from '@/lib/harness-descriptors'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentKind,
  issueAgentLabel,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { useMyCodingHarness } from '@/lib/my-preferences'
import { cn } from '@/lib/utils'
import { ActivationShell } from './ActivationShell'
import type { ActivationRoute } from './activation-route'
import { readFirstTaskDraft, serializeFirstTaskDraft } from './first-task-draft'
import { authRequest } from './member-api'
import { OnboardingAccountChoices } from './OnboardingAccountChoices'
import { SetupError } from './SetupFeedback'

export const FirstTaskActivation = observer(function FirstTaskActivation({
  route,
  onRouteChange,
  onComplete,
}: {
  route: Extract<ActivationRoute, 'agent' | 'first-task'>
  onRouteChange: (route: ActivationRoute) => void
  onComplete: () => void
}): JSX.Element {
  const { trpc } = useSettingsClient()
  const { repos, machines } = useSettingsCatalog()
  const repoChoices = useMemo(
    () =>
      repos.filter((repo) => repo.kind !== 'worktree').sort((a, b) => a.path.localeCompare(b.path)),
    [repos],
  )
  const [draft, setDraft] = useSettingsDraft(
    FIRST_TASK_ACTIVATION_DRAFT_KEY,
    readFirstTaskDraft,
    serializeFirstTaskDraft,
  )
  const [configuredAgent, setConfiguredAgent] = useState<IssueAgentKind | null>(null)
  const [loginBusyAgent, setLoginBusyAgent] = useState<IssueAgentKind | null>(null)
  const [loginSessionId, setLoginSessionId] = useState<SessionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)

  const finishSetup = async (): Promise<void> => {
    if (finishing) return
    setFinishing(true)
    setError(null)
    try {
      await authRequest(serverConfig(window.location).httpOrigin, 'admin/setup/finish', {})
      onComplete()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setFinishing(false)
    }
  }

  // My coding default, from my synced settings (POD-6673).
  const codingHarness = useMyCodingHarness()
  useEffect(() => {
    if (codingHarness === undefined) return
    setConfiguredAgent(issueAgentKind(codingHarness) ?? issueDefaultAgentKind(undefined))
  }, [codingHarness])

  const selectedRepo = repoChoices.find((repo) => repo.path === draft.repoPath) ?? repoChoices[0]
  useEffect(() => {
    if (!selectedRepo || draft.repoPath === selectedRepo.path) return
    setDraft({ ...draft, repoPath: selectedRepo.path })
  }, [draft, selectedRepo, setDraft])

  // Read the shared machine models while observed: installation arrives through
  // inventory sync without replacing the catalog's machine array.
  const readinessByAgent = Object.fromEntries(
    ISSUE_AGENT_KINDS.map((agent) => [
      agent,
      activationAgentReadiness(selectedRepo, machines, agent),
    ]),
  ) as Record<IssueAgentKind, ReturnType<typeof activationAgentReadiness>>
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
      const result = await trpc.credentials.login.mutate({
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

  // POD-2700 §3.3: the `?? machines[0]` this replaces was one of the retired
  // fallbacks — on a fleet whose first row is the server-only coordinator it
  // named a machine that can run nothing, and the login/readiness panel then
  // reported that machine's (empty) agent inventory as the user's. Falling back
  // only within the repo-capable machines keeps the panel honest; `undefined` is
  // an answer the caller below already renders.
  const selectedMachine =
    machines.find((machine) => machine.id === selectedRepo?.machineId) ??
    machinesFor(machines, HOST_REPOS).find((machine) => machine.online) ??
    machinesFor(machines, HOST_REPOS)[0]
  // Served descriptors for the machine under setup (POD-4475): login copy,
  // labels, icons and brand all render from here, bundled copy offline.
  // A hook: it stays above the first-task early return below, or the agent → first-task
  // step renders fewer hooks than the step before and React aborts (error #300).
  const descriptors = useResolvedDescriptors([selectedMachine?.id])

  if (route === 'first-task') {
    return (
      <ActivationShell
        eyebrow="Set up Podium · Ready"
        title="Podium is good to go."
        description="Your project and agents are set up. You can start working."
        icon={<Check aria-hidden="true" />}
        contentClassName="mt-8"
        frameClassName="lg:pt-14 lg:pb-11 [&>div:first-child]:bg-[#2a2418] [&>div:first-child]:shadow-[inset_0_0_0_1px_#4a4331]"
      >
        {error && <SetupError>{error}</SetupError>}
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            data-pressable
            disabled={finishing}
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
            onClick={() => void finishSetup()}
            disabled={finishing}
            className="inline-flex h-[38px] items-center gap-2 rounded-[9px] bg-[#d9b477] px-[18px] text-[13.5px] leading-none font-semibold text-[#191308] hover:bg-[#e8ca97] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>{finishing ? 'Finishing setup…' : 'Finish setup'}</span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
      </ActivationShell>
    )
  }

  const descriptorByKind = new Map(descriptors.map((d) => [d.kind, d]))
  const agentLogin = (agent: IssueAgentKind) => descriptorByKind.get(agent)?.login
  const otherAgents = ISSUE_AGENT_KINDS.filter(
    (agent) => !activationAgentIsReady(readinessByAgent[agent]),
  )
  const renderAgentRows = (agents: readonly IssueAgentKind[]): JSX.Element[] =>
    agents.map((agent, index) => {
      const readiness = readinessByAgent[agent]
      const row = selectedMachine?.harnessInstalls.find((row) => row.kind === agent)
      const ready = activationAgentIsReady(readiness)
      const needsLogin = readiness.state === 'logged-out'
      return (
        <div
          key={agent}
          className={cn('px-5', index < agents.length - 1 && 'border-b border-[#272b33]')}
        >
          {row && <MachineHarnessRow row={row} client={trpc} />}
          {readiness.state !== 'missing' && row?.state !== 'installing' && (
            <div className="flex flex-wrap items-center gap-3 pb-4">
              <p className="settings-prose min-w-0 flex-1 max-sm:basis-full">
                {needsLogin && agentLogin(agent)?.signedOutHint
                  ? agentLogin(agent)?.signedOutHint
                  : activationReadinessCopy(readiness, issueAgentLabel(agent, descriptors))}
              </p>
              {ready ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-[#69c48a]">
                  <CheckCircle2 size={16} aria-hidden="true" />
                  Ready
                </span>
              ) : needsLogin ? (
                <>
                  <span className="inline-flex items-center gap-1.5 text-xs text-[#a8adb6]">
                    <CircleAlert size={16} aria-hidden="true" />
                    Sign-in optional
                  </span>
                  <button
                    type="button"
                    data-pressable
                    disabled={loginBusyAgent !== null}
                    onClick={() => void openLogin(agent)}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[9px] px-3 text-[12.5px] font-semibold text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56] hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d9b477] disabled:opacity-50 sm:min-h-[31px]"
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
                </>
              ) : null}
            </div>
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
          . Install an agent below, or continue with one already installed. Sign in now or later,
          before you run one.
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

      <OnboardingAccountChoices />

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
          className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d9b477]"
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
          className="inline-flex h-[34px] items-center gap-2 rounded-[9px] bg-[#d9b477] px-[15px] text-[13px] leading-none font-semibold text-[#191308] hover:bg-[#e8ca97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2f3f5] disabled:cursor-not-allowed disabled:opacity-40"
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
})
