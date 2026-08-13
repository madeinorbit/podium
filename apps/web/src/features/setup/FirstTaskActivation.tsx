import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { shallowEqual } from '@podium/client-core/store'
import type { HarnessAgent, SessionId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  LoaderCircle,
  SquareTerminal,
} from 'lucide-react'
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
  const steps = ['Project', 'Agents', 'Start using Podium'] as const
  const active = current === 'agent' ? 1 : 2
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      {steps.map((step, index) => (
        <li key={step} className="contents">
          {index > 0 && <span aria-hidden="true">→</span>}
          <span
            className={cn('inline-flex items-center gap-1.5', index <= active && 'text-foreground')}
          >
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border border-border',
                index < active && 'border-success/30 bg-success/15 text-success',
                index === active && 'border-primary/35 bg-primary/10 text-primary',
              )}
            >
              {index < active ? <Check size={12} aria-hidden="true" /> : index + 1}
            </span>
            {step}
          </span>
        </li>
      ))}
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

  return (
    <ActivationShell
      eyebrow="Activate Podium · Step 2 of 3"
      title="Set up the agents you want to use."
      description="These are the coding agents Podium supports. Ready agents can start work now; the others show exactly what is still needed on this machine."
      onExplore={onExplore}
    >
      <ActivationSteps current="agent" />
      <div className="max-w-[760px] space-y-3">
        <div className="overflow-hidden rounded-xl border border-border-strong bg-background/45">
          {ISSUE_AGENT_KINDS.map((agent, index) => {
            const readiness = readinessByAgent[agent]
            const ready = activationAgentIsReady(readiness)
            const selected = selectedAgent === agent
            return (
              <div
                key={agent}
                className={cn(
                  'flex gap-3 px-4 py-3.5',
                  index > 0 && 'border-t border-border',
                  !ready && 'bg-muted/[0.16]',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg border',
                    ready
                      ? 'border-success/25 bg-success/10'
                      : 'border-border bg-muted/30 opacity-60',
                  )}
                >
                  {issueAgentIcon(agent, 17)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'text-sm font-semibold',
                        ready ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {issueAgentLabel(agent)}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
                        ready
                          ? 'border-success/25 bg-success/10 text-success'
                          : 'border-border bg-muted/35 text-muted-foreground',
                      )}
                    >
                      {ready ? (
                        <Check size={11} aria-hidden="true" />
                      ) : (
                        <CircleAlert size={11} aria-hidden="true" />
                      )}
                      {ready ? 'Ready to use' : 'Setup needed'}
                    </span>
                    {selected && ready && (
                      <span className="text-[10.5px] text-muted-foreground">Default</span>
                    )}
                  </div>
                  <p
                    className={cn(
                      'mt-1 text-xs leading-5',
                      ready ? 'text-muted-foreground' : 'text-muted-foreground/80',
                    )}
                  >
                    {setupHint(agent, readiness)}
                  </p>
                </div>
                <div className="flex flex-none items-center">
                  {readiness.state === 'logged-out' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={loginBusyAgent !== null}
                      onClick={() => void openLogin(agent)}
                    >
                      {loginBusyAgent === agent ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : (
                        <SquareTerminal aria-hidden="true" />
                      )}
                      Sign in
                    </Button>
                  ) : ready && !selected ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => chooseDefault(agent)}
                    >
                      Use by default
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>

        {error && <SetupError>{error}</SetupError>}

        <div className="flex flex-wrap justify-between gap-2 border-t border-border-strong pt-4">
          <Button type="button" variant="ghost" onClick={() => onRouteChange('local-project')}>
            <ArrowLeft aria-hidden="true" />
            Change project
          </Button>
          <Button
            type="button"
            disabled={readyAgents.length === 0}
            onClick={() => onRouteChange('first-task')}
          >
            Continue
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <SetupLoginTerminalDialog
        sessionId={loginSessionId}
        onClose={() => setLoginSessionId(null)}
      />
    </ActivationShell>
  )
}
