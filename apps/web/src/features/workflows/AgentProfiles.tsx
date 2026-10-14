/**
 * AGENT PROFILES, as the workflows surface sees them (POD-6114).
 *
 * A workflow step names an agent profile and a run pins it when it starts. This
 * tab lists the profiles a step can name, read-only: profiles are edited by
 * people through `podium profile` (their own UI is POD-6098), not here. It
 * replaced the execution-profile editor, whose table is gone.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT STAYS VISIBLE, AND FAILS CLOSED
 * ---------------------------------------------------------------------------
 *
 * A profile's `machineId` decides where a step's work executes — the USE verb
 * (readiness §3.1.4 M1), a code-execution boundary (M2). So each row says where
 * its work would land for THIS principal, keeping UNAUTHORIZED and UNREACHABLE
 * apart, because "ask the owner" and "wake it up" are opposite recoveries. A
 * profile with no machine reads "runs where the issue runs": the spawn places
 * it by the issue's worktree, never on "whatever is available".
 */
import { profilePlacement } from '@podium/client-core/values'
import type { JSX } from 'react'
import { useWorkflowMachines } from './readers'
import type { WorkflowsSource } from './use-workflows'
import { Empty } from './workflow-ui'

const PLACEMENT_WORDS: Record<string, string> = {
  available: 'available',
  unreachable: 'offline — try again later',
  // POD-2700: a THIRD refusal, not a shade of offline. Nothing to try again for.
  incapable: 'runs no Podium daemon — it can never execute here',
  disabled: 'agent hosting disabled on this machine',
  degraded: 'agent hosting unavailable — restart Podium on this machine',
  unauthorized: 'no access — ask its owner',
  unplaced: 'runs where the issue runs',
  unknown: 'unknown machine',
}

export function AgentProfiles({ source }: { source: WorkflowsSource }): JSX.Element {
  const { views, pending } = useWorkflowMachines()

  if (pending)
    return (
      <section className="min-h-0 flex-1 overflow-y-auto p-5">
        <p role="status" className="text-xs text-muted-foreground">
          Loading agent profiles…
        </p>
      </section>
    )

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl">
        <h2 className="mb-1 text-lg font-semibold">Agent profiles</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          A step names one with <code>"agentProfile": "&lt;name&gt;"</code>; a run pins it when it
          starts. Edit profiles with <code>podium profile</code>.
        </p>
        {source.profiles.length === 0 ? (
          <Empty>No agent profiles.</Empty>
        ) : (
          <div className="space-y-2">
            {source.profiles.map((profile) => {
              const placement = profilePlacement(profile, views)
              return (
                <div key={profile.id} className="rounded-lg border p-3" data-profile-id={profile.id}>
                  <div className="text-sm font-medium">{profile.name}</div>
                  {profile.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {profile.description}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {profile.candidates.length === 0
                      ? 'Settings default agent'
                      : profile.candidates
                          .map((c) => `${c.harness} · ${c.model} · ${c.effort}`)
                          .join(', then ')}
                  </div>
                  <div
                    className="mt-1 text-[11px] text-muted-foreground"
                    data-placement={placement.state}
                  >
                    {profile.machineId ? `machine ${profile.machineName ?? profile.machineId} · ` : ''}
                    placement: {PLACEMENT_WORDS[placement.state]}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
