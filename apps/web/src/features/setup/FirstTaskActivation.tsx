import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { shallowEqual } from '@podium/client-core/store'
import type { HarnessAgent, SessionId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { ArrowLeft, ArrowRight, Check, ChevronDown, LoaderCircle } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SetupLoginTerminalDialog } from '@/app/SetupLoginTerminalDialog'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  ISSUE_AGENT_KINDS,
  issueAgentIcon,
  issueAgentKind,
  issueAgentLabel,
  type IssueAgentKind,
} from '@/lib/issue-agents'
import { cn } from '@/lib/utils'
import { ActivationShell } from './ActivationShell'
import {
  activationAgentIsReady,
  activationAgentReadiness,
  activationReadinessCopy,
  type ActivationAgentReadiness,
} from './agent-readiness'
import type { ActivationRoute } from './activation-route'
import { persistFirstTaskDraft, readFirstTaskDraft } from './first-task-draft'
import { SetupError } from './SetupFeedback'

function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function ActivationSteps({ current }: { current: 'agent' | 'ready' }): JSX.Element {
  const ready = current === 'ready'
  return (
    <ol className="flex max-w-[1060px] items-center font-mono text-[10.5px] leading-none">
      <li className="inline-flex items-center gap-2 text-[#a8adb6]">
        <Check size={14} className="text-[#6f9dff]" aria-hidden="true" />
        project
      </li>
      <li className="mx-3 h-px w-[46px] bg-gradient-to-r from-[#6f9dff] to-[#8b83ff]" />
      <li className="inline-flex items-center gap-2 text-[#f2f3f5]">
        {ready ? (
          <Check size={14} className="text-[#6f9dff]" aria-hidden="true" />
        ) : (
          <span className="text-[#8b83ff]">02</span>
        )}
        agents
      </li>
      <li className={cn('mx-3 h-px w-[46px]', ready ? 'bg-[#8b83ff]' : 'bg-[#2c2f35]')} />
      <li
        className={cn(
          'inline-flex items-center gap-2',
          ready ? 'text-[#f2f3f5]' : 'text-[#6f7580]',
        )}
      >
        <span className={ready ? 'text-[#8b83ff]' : 'text-[#a8adb6]'}>03</span>
        first mission
      </li>
    </ol>
  )
}

function setupHint(agent: IssueAgentKind, readiness: ActivationAgentReadiness): string {
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

export function FirstTaskActivation({
  route,
  onRouteChange,
  onExplore,
  onComplete,
}: {
  route: Extract<ActivationRoute, 'agent' | 'first-task'>
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
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
  const readyAgents = ISSUE_AGENT_KINDS.filter((agent) =>
    activationAgentIsReady(readinessByAgent[agent]),
  )
  const selectedAgent =
    issueAgentKind(draft.agent) ?? configuredAgent ?? readyAgents[0] ?? 'claude-code'

  useEffect(() => {
    if (!configuredAgent || draft.agent) return
    const preferred = activationAgentIsReady(readinessByAgent[configuredAgent])
      ? configuredAgent
      : readyAgents[0]
    if (preferred) setDraft({ ...draft, agent: preferred })
  }, [configuredAgent, draft, readinessByAgent, readyAgents, setDraft])

  const chooseDefault = (agent: IssueAgentKind): void => {
    setDraft({ ...draft, agent, model: 'auto', effort: 'auto' })
  }

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
    return (
      <ActivationShell
        eyebrow="Activate Podium · Step 3 of 3"
        title="Podium is ready."
        description="Your project is connected and at least one agent is available. Continue into Podium; when no task is selected, the workspace will help you start one."
        onExplore={onExplore}
      >
        <ActivationSteps current="ready" />
        <div className="max-w-[680px] rounded-xl border border-border bg-background/45 px-5 py-6 shadow-sm">
          <div className="flex size-10 items-center justify-center rounded-full border border-success/25 bg-success/10 text-success">
            <Check size={20} aria-hidden="true" />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">
            {selectedRepo ? repoLabel(selectedRepo.path) : 'Your project'} is ready to use.
          </p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
            You can add more projects, agents, and machines later without returning to setup.
          </p>
          <Button type="button" size="lg" className="mt-6 min-w-40" onClick={onComplete}>
            Let&apos;s go
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </ActivationShell>
    )
  }

  const selectedMachine =
    machines.find((machine) => machine.id === selectedRepo?.machineId) ?? machines[0]
  const blockedAgents = ISSUE_AGENT_KINDS.filter(
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
      const selected = selectedAgent === agent
      const needsLogin = readiness.state === 'logged-out'
      const setupCommand =
        readiness.state === 'missing' && (agent === 'opencode' || agent === 'cursor')
          ? agent === 'cursor'
            ? 'cursor-agent login'
            : 'opencode auth login'
          : null
      const status = ready ? 'ready' : needsLogin ? 'sign in' : 'waiting'

      return (
        <div
          key={agent}
          className={cn(
            'flex items-center gap-3.5 px-[18px] py-[15px]',
            index < agents.length - 1 && 'border-b border-[#23262b]',
          )}
        >
          <div
            className={cn(
              'flex size-[34px] flex-none items-center justify-center rounded-[9px] bg-[#16171a] shadow-[inset_0_0_0_1px_#26292f]',
              agent === 'claude-code'
                ? '[&_svg]:text-[#d97757]'
                : ready
                  ? '[&_svg]:text-[#d7dae0]'
                  : '[&_svg]:text-[#8a9099]',
            )}
          >
            {issueAgentIcon(agent, agent === 'claude-code' ? 18 : 17)}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'truncate text-[14px] leading-none font-semibold',
                  ready ? 'text-[#f2f3f5]' : 'text-[#d7dae0]',
                )}
              >
                {issueAgentLabel(agent)}
              </span>
              {selected && ready && (
                <span className="inline-flex h-[19px] items-center rounded-[5px] bg-[#1e2024] px-2 font-mono text-[8.5px] leading-none tracking-[0.12em] text-[#e3ba52] uppercase">
                  Default
                </span>
              )}
            </div>
            {agent === 'cursor' && setupCommand ? (
              <p className="mt-[5px] flex min-w-0 items-center gap-2 truncate font-mono text-[11px] leading-none text-[#6f7580]">
                <span>not installed · run</span>
                <code className="inline-flex h-5 items-center rounded-[5px] bg-[#16171a] px-2 text-[#a8adb6] shadow-[inset_0_0_0_1px_#26292f]">
                  {setupCommand}
                </code>
                <span>and Podium detects it</span>
              </p>
            ) : (
              <p className="mt-[5px] truncate font-mono text-[11px] leading-[1.4] text-[#6f7580]">
                {setupHint(agent, readiness)}
              </p>
            )}
          </div>

          <span
            className={cn(
              'hidden flex-none items-center gap-[7px] font-mono text-[10.5px] leading-none sm:inline-flex',
              ready ? 'text-[#6f9dff]' : needsLogin ? 'text-[#e3ba52]' : 'text-[#6f7580]',
            )}
          >
            <span
              className={cn(
                'size-[5px] rounded-full',
                ready ? 'bg-[#6f9dff]' : needsLogin ? 'bg-[#e3ba52]' : 'bg-[#3a3f48]',
              )}
              aria-hidden="true"
            />
            {status}
          </span>

          {needsLogin ? (
            <button
              type="button"
              disabled={loginBusyAgent !== null}
              onClick={() => void openLogin(agent)}
              className="inline-flex h-7 w-28 flex-none items-center justify-center gap-1.5 rounded-lg bg-[#e3ba52] text-[11.5px] leading-none font-semibold text-[#1a1408] hover:bg-[#efc95f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2f3f5] disabled:opacity-50"
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
          ) : ready && !selected ? (
            <button
              type="button"
              onClick={() => chooseDefault(agent)}
              className="h-7 w-28 flex-none rounded-lg font-mono text-[11px] leading-none text-[#a8adb6] shadow-[inset_0_0_0_1px_#26292f] hover:bg-white/[0.035] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-[#8b83ff]"
            >
              make default
            </button>
          ) : setupCommand ? (
            <button
              type="button"
              onClick={() => copySetupCommand(agent)}
              className="h-7 w-28 flex-none rounded-lg font-mono text-[11px] leading-none text-[#a8adb6] shadow-[inset_0_0_0_1px_#26292f] hover:bg-white/[0.035] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-[#8b83ff]"
            >
              copy command
            </button>
          ) : (
            <span className="hidden w-28 flex-none sm:block" aria-hidden="true" />
          )}
        </div>
      )
    })

  return (
    <main className="native-agents-pane relative" aria-labelledby="activation-title">
      <div className="workspace-sheet min-h-0 overflow-y-auto bg-[#131417]">
        <div className="flex min-h-full w-full flex-col bg-[#131417] px-5 pt-12 pb-14 font-sans sm:px-10 lg:px-24 lg:pt-16">
          <div className="flex max-w-[1060px] items-center gap-3.5">
            <p className="inline-flex items-center gap-[7px] font-mono text-[8.5px] leading-none tracking-[0.2em] text-[#8b83ff] uppercase">
              <span className="size-[5px] rounded-full bg-[#8b83ff]" aria-hidden="true" />
              Activate
            </p>
            <span className="h-px flex-1 bg-[#1e2024]" aria-hidden="true" />
            <span className="font-mono text-[10.5px] leading-none text-[#6f7580]">step 2 of 3</span>
          </div>

          <h1
            id="activation-title"
            className="mt-7 flex flex-wrap items-center gap-[13px] text-[clamp(26px,3vw,33px)] leading-[1.15] font-semibold tracking-[-0.022em] text-[#f2f3f5]"
          >
            <span>Set up the agents on</span>
            <span className="inline-flex h-12 items-center gap-[11px] rounded-[11px] bg-[#1b1d21] px-[13px] shadow-[inset_0_0_0_1px_#2c2f35]">
              <span className="size-[7px] rounded-full bg-[#6f9dff]" aria-hidden="true" />
              <span className="font-mono text-[26px] leading-none tracking-[-0.01em]">
                {selectedMachine?.hostname ?? selectedMachine?.name ?? 'this machine'}
              </span>
              <ChevronDown size={20} className="text-[#949aa4]" aria-hidden="true" />
            </span>
          </h1>

          <div className="mt-[22px] flex max-w-[1060px] items-center">
            <ActivationSteps current="agent" />
            <span className="ml-5 h-px min-w-5 flex-1 bg-[#1e2024]" aria-hidden="true" />
            <span className="ml-3 font-mono text-[10.5px] leading-none whitespace-nowrap text-[#6f7580]">
              {readyAgents.length} ready · {blockedAgents.length} blocked
            </span>
          </div>

          <div className="mt-[26px] max-w-[1060px] overflow-hidden rounded-[14px] bg-[#1b1d21] shadow-[inset_0_0_0_1px_#2c2f35,0_20px_50px_-30px_rgba(0,0,0,.9)]">
            {readyAgents.length > 0 && (
              <>
                <div className="flex items-center gap-2.5 border-b border-[#23262b] bg-[#191a1e] px-[18px] py-[9px] font-mono text-[8.5px] leading-none tracking-[0.16em] text-[#6f7580] uppercase">
                  <span className="flex-1">Ready now</span>
                  <span className="text-[#6f9dff]">{readyAgents.length}</span>
                </div>
                {renderAgentRows(readyAgents)}
              </>
            )}
            {blockedAgents.length > 0 && (
              <>
                <div className="flex items-center gap-2.5 border-y border-[#23262b] bg-[#191a1e] px-[18px] py-[9px] font-mono text-[8.5px] leading-none tracking-[0.16em] text-[#6f7580] uppercase first:border-t-0">
                  <span className="flex-1">Needs one step</span>
                  <span className="text-[#e3ba52]">{blockedAgents.length}</span>
                </div>
                {renderAgentRows(blockedAgents)}
              </>
            )}
          </div>

          {error && (
            <div className="mt-3 max-w-[1060px]">
              <SetupError>{error}</SetupError>
            </div>
          )}

          <div className="mt-[22px] flex max-w-[1060px] flex-wrap items-center gap-3.5">
            <button
              type="button"
              onClick={() => onRouteChange('local-project')}
              className="inline-flex items-center gap-2 text-[11.5px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8b83ff]"
            >
              <ArrowLeft size={15} className="text-[#6f7580]" aria-hidden="true" />
              Change project
            </button>
            <span className="flex-1" />
            <span className="font-mono text-[10px] leading-none text-[#6f7580]">
              {readyAgents.length} ready is enough — the rest can wait
            </span>
            <button
              type="button"
              disabled={readyAgents.length === 0}
              onClick={() => onRouteChange('first-task')}
              className="inline-flex h-[30px] items-center gap-[7px] rounded-[9px] bg-[#e3ba52] px-3.5 text-[12px] leading-none font-semibold text-[#1a1408] hover:bg-[#efc95f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2f3f5] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-11 flex max-w-[1060px] items-center gap-3 border-t border-[#1e2024] pt-5">
            <button
              type="button"
              onClick={onExplore}
              className="inline-flex h-7 items-center gap-[7px] rounded-lg px-3 text-[11.5px] leading-none text-[#a8adb6] shadow-[inset_0_0_0_1px_#26292f] hover:bg-white/[0.035] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-[#8b83ff]"
            >
              Explore Podium
              <ArrowRight size={14} className="text-[#6f7580]" aria-hidden="true" />
            </button>
            <span className="font-mono text-[10.5px] leading-none text-[#6f7580]">
              setup stays ready here until you return
            </span>
          </div>
        </div>
      </div>
      <SetupLoginTerminalDialog
        sessionId={loginSessionId}
        onClose={() => setLoginSessionId(null)}
      />
    </main>
  )
}
