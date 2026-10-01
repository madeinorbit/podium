import type { IssueUpdatePatch } from '@podium/commands'
import { asMachineId, HOST_REPOS, type IssueWire, type MachineId } from '@podium/model/browser'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { DropdownMenuOwner } from '@/components/ui/dropdown-menu'
import { machineOptionLabel, useMachineChoices } from '@/features/machines/machine-choices'
import { CapabilityAgentMenu } from '@/lib/agent-capability'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { issueAgentLabel, issueDefaultAgentKind } from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { PropertyMenu } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import type { LaunchMachine } from './LaunchBox'
import { useAgentFleetOptions } from './use-agent-fleet-options'

type SettingsIssue = Pick<IssueWire, 'id'> &
  Partial<
    Pick<IssueWire, 'repoPath' | 'defaultAgent' | 'defaultModel' | 'defaultEffort' | 'machineId'>
  >
type SettingsPatch = Pick<
  IssueUpdatePatch,
  'defaultAgent' | 'defaultModel' | 'defaultEffort' | 'machineId'
>
type Selection = {
  defaultAgent: string
  defaultModel: string
  defaultEffort: string
  machineId: MachineId | null
}

const ISSUE_HOME_COPY = {
  action: 'hold this issue',
  capability: 'hold worktrees',
  remedy: 'Pair a machine that runs the Podium daemon.',
}

/** The persisted plan for an issue's next agent, shared by every issue viewer. */
export function IssueAgentSettings({
  issue,
  machines,
  disabled = false,
  compact = false,
  menuOwner,
  onSavingChange,
}: {
  issue: SettingsIssue
  machines: LaunchMachine[]
  disabled?: boolean
  compact?: boolean
  menuOwner?: string
  onSavingChange?: (saving: boolean) => void
}): JSX.Element {
  const updateIssue = useStoreSelector((s) => s.updateIssue)
  const defaultAgent = issue.defaultAgent ?? issueDefaultAgentKind(undefined)
  const defaultModel = issue.defaultModel || 'auto'
  const defaultEffort = issue.defaultEffort || 'auto'
  const machineId = issue.machineId ?? null
  const [selected, setSelected] = useState<Selection>({
    defaultAgent,
    defaultModel,
    defaultEffort,
    machineId,
  })
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const pending = useRef(false)

  useEffect(() => {
    setSelected({ defaultAgent, defaultModel, defaultEffort, machineId })
  }, [defaultAgent, defaultModel, defaultEffort, machineId])
  useEffect(() => {
    onSavingChange?.(state === 'saving')
    return () => onSavingChange?.(false)
  }, [state, onSavingChange])
  useEffect(() => {
    if (state !== 'saved') return
    const timeout = window.setTimeout(() => setState('idle'), 1200)
    return () => window.clearTimeout(timeout)
  }, [state])

  const save = (patch: SettingsPatch): void => {
    if (disabled || pending.current) return
    const previous = selected
    pending.current = true
    setSelected({ ...selected, ...patch })
    setState('saving')
    setError('')
    void (async () => {
      try {
        await updateIssue(issue.id, patch)
        setState('saved')
      } catch (cause) {
        setSelected(previous)
        setState('idle')
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        pending.current = false
      }
    })()
  }

  const agentKind = issueDefaultAgentKind(selected.defaultAgent)
  const AgentIcon = agentIconFor(agentKind)
  const agentOptions = useAgentFleetOptions(issue)
  const machine = machines.find((m) => m.id === selected.machineId)
  const machineChoices = useMachineChoices(
    machines,
    HOST_REPOS,
    ISSUE_HOME_COPY,
    selected.machineId ?? undefined,
  )
  const busy = disabled || state === 'saving'
  const catalogMachine = selected.machineId ? { machineId: selected.machineId } : {}

  return (
    <DropdownMenuOwner value={menuOwner}>
      <div
        data-testid="issue-agent-settings"
        className={cn('flex flex-col gap-1.5', compact && 'text-[11px]')}
      >
        <div className="flex min-h-4 items-center justify-between gap-2">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase">
            Planned agent
          </span>
          <span role="status" className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {state === 'saving' && (
              <>
                <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
                Saving…
              </>
            )}
            {state === 'saved' && (
              <>
                <Check size={12} className="text-success" aria-hidden="true" />
                Saved
              </>
            )}
          </span>
        </div>
        <div className="overflow-hidden rounded-lg bg-[var(--well-floor)] shadow-[inset_0_0_0_1px_var(--hairline-bar)]">
          <CapabilityAgentMenu
            selectedValue={agentKind}
            options={agentOptions}
            onSelect={(value) => {
              if (value !== selected.defaultAgent)
                save({ defaultAgent: value, defaultModel: 'auto', defaultEffort: 'auto' })
            }}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={compact ? 'Planned agent harness' : 'Agent'}
                title={`Sessions on this task launch with ${issueAgentLabel(agentKind)}`}
                className="h-7 w-full justify-start gap-1.5 rounded-none px-2.5 text-[12px] font-normal text-text-strong"
              >
                <span
                  className={cn(
                    'flex size-[15px] flex-none items-center justify-center rounded-[4px] border',
                    agentFleetTileTint(agentKind),
                  )}
                  aria-hidden="true"
                >
                  {AgentIcon ? <AgentIcon size={10} strokeWidth={1.8} /> : '✳'}
                </span>
                <span className="min-w-0 truncate">{issueAgentLabel(agentKind)}</span>
                <ChevronDown size={13} aria-hidden="true" className="ml-auto text-text-faint" />
              </Button>
            }
          />
          <div className="h-px bg-hairline-bar" aria-hidden="true" />
          <div className="flex items-stretch">
            <ModelPicker
              variant="composer"
              className="min-w-0 shrink flex-1 justify-between"
              agentKind={agentKind}
              {...catalogMachine}
              disabled={busy}
              value={selected.defaultModel}
              onChange={(value) => {
                if (value !== selected.defaultModel)
                  save({ defaultModel: value, defaultEffort: 'auto' })
              }}
            />
            <EffortPicker
              variant="composer"
              className="min-w-0 shrink flex-1 justify-between border-l-hairline-bar"
              agentKind={agentKind}
              {...catalogMachine}
              disabled={busy}
              model={selected.defaultModel}
              value={selected.defaultEffort}
              onChange={(value) => {
                if (value !== selected.defaultEffort) save({ defaultEffort: value })
              }}
            />
            <PropertyMenu
              selectedValue={selected.machineId ?? 'auto'}
              footnote={machineChoices.exclusionNote}
              options={[
                { value: 'auto', label: 'auto machine' },
                ...machineChoices.options.map((choice) => ({
                  value: choice.machine.id,
                  label: machineOptionLabel(choice),
                })),
              ]}
              onSelect={(value) => {
                const next = value === 'auto' ? null : asMachineId(value)
                if (next !== selected.machineId) save({ machineId: next })
              }}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label="Machine"
                  className="h-7 min-w-0 shrink flex-1 justify-between gap-1 rounded-none border-l-hairline-bar px-2.5 font-mono text-[11px] font-normal text-text-dim"
                >
                  <span className="min-w-0 truncate">
                    {machine?.name ?? selected.machineId ?? 'auto'}
                  </span>
                  <ChevronDown size={13} aria-hidden="true" className="text-text-faint" />
                </Button>
              }
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-[10.5px] leading-snug text-destructive">
            {error}
          </p>
        )}
      </div>
    </DropdownMenuOwner>
  )
}
