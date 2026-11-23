import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import {
  activationAgentIsInstalled,
  activationAgentIsReady,
  activationAgentReadiness,
} from '@podium/client-core/values'
import type { MachineModel } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import { HOST_REPOS, machinesFor } from '@podium/model'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { useSettingsCatalog, useSettingsDraft } from '@/features/settings/readers'
import { SetupAgentsPanel } from '@/features/setup-agents/SetupAgentsPanel'
import { useAgentSetupView } from '@/features/setup-agents/use-agent-setup-view'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentKind,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { useMyCodingHarness } from '@/lib/my-preferences'
import { ActivationBack, ActivationShell } from './ActivationShell'
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
      contentClassName="mt-7 max-w-[860px]"
    >
      {selectedMachine ? (
        <OnboardingAgentSetup
          key={selectedMachine.id}
          machine={selectedMachine}
          onRouteChange={onRouteChange}
        />
      ) : (
        <>
          <SetupError>No machine currently hosts this project. Choose another project.</SetupError>
          <div className="mt-8">
            <ActivationBack label="Change project" onBack={() => onRouteChange('local-project')} />
          </div>
        </>
      )}
    </ActivationShell>
  )
})

const OnboardingAgentSetup = observer(function OnboardingAgentSetup({
  machine,
  onRouteChange,
}: {
  machine: MachineModel
  onRouteChange: (route: ActivationRoute) => void
}) {
  const view = useAgentSetupView({ machine, origin: 'onboarding' })
  const checking = view.checking
  useEffect(() => {
    if (checking) return
    // Seed this opening when inventory arrives; selection changes do not reseed it.
    if (view.items.some((item) => item.usable || item.installing)) view.clearSelection()
    else view.selectSuggested()
  }, [view, checking])

  const selectedCount = view.selectedKinds.length
  const ready = view.reachable && view.items.some((item) => item.readyToStart)
  const canContinue = ready || (view.reachable && view.items.some((item) => item.installing))
  const continueSetup = () => onRouteChange('first-task')

  return (
    <>
      <div className="[--background:#16171a] [--border:#2f343d] [--card:#1b1e24] [--foreground:#f2f3f5] [--muted:#2b2f37] [--muted-foreground:#a8adb6] [--primary:#d9b477] [--primary-foreground:#191308] [--ring:#d9b477] [--success:#69c48a] [--warning:#f5c518]">
        <SetupAgentsPanel view={view} variant="onboarding" />
      </div>

      <OnboardingAccountChoices />

      <div className="mt-8 flex flex-wrap items-center gap-3.5">
        <ActivationBack label="Change project" onBack={() => onRouteChange('local-project')} />
        <span className="flex-1" />
        {ready && selectedCount > 0 && (
          <button
            type="button"
            data-pressable
            onClick={continueSetup}
            className="min-h-11 text-[13px] text-[#a8adb6] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d9b477]"
          >
            Continue without installing
          </button>
        )}
        <button
          type="button"
          data-pressable
          disabled={selectedCount > 0 ? !view.canInstallSelected : !canContinue}
          onClick={() => {
            if (selectedCount > 0) view.installSelected()
            continueSetup()
          }}
          className="inline-flex min-h-11 items-center gap-2 rounded-[9px] bg-[#d9b477] px-[15px] text-[13px] leading-none font-semibold text-[#191308] hover:bg-[#e8ca97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2f3f5] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-[34px]"
        >
          {selectedCount > 0 ? `Install ${selectedCount} and continue` : 'Continue'}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-3 text-right text-xs text-[#6f757f]">
        Installs keep running while you finish setup.
      </p>
    </>
  )
})
