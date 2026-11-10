import type { PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import type { SecretSurfaceState } from './secrets'
import {
  CommitInput,
  clampInt,
  Row,
  SecretRow,
  Section,
  SegmentedRow,
  SwitchRow,
  TextRow,
} from './shared'

interface LinearSecret {
  state: SecretSurfaceState
  busy: boolean
  error: string | null
  onSet: (value: string) => Promise<unknown>
  onClear: () => Promise<unknown>
}

/** Workspace defaults for how tasks branch, land and get cleaned up. */
export const WorkflowSection = observer(function WorkflowSection({
  settings,
  patch,
  linear,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
  linear?: LinearSecret
}): JSX.Element {
  return (
    <>
      <Section title="Branches and landing">
        <TextRow
          setting="gitWorkflow.defaultParentBranch"
          label="Default base branch"
          description="Where new tasks branch from and land, unless the project sets its own."
          placeholder="Each repo’s main branch"
          value={settings.gitWorkflow.defaultParentBranch}
          onChange={(value) =>
            patch({ gitWorkflow: { ...settings.gitWorkflow, defaultParentBranch: value.trim() } })
          }
        />
        <SwitchRow
          setting="gitWorkflow.autoRebaseBeforeMerge"
          label="Rebase before landing"
          description="Brings a task’s branch up to date with its base before it merges, so landing is a fast-forward."
          value={settings.gitWorkflow.autoRebaseBeforeMerge}
          onChange={(value) =>
            patch({ gitWorkflow: { ...settings.gitWorkflow, autoRebaseBeforeMerge: value } })
          }
        />
      </Section>
      <Section
        title="Worktree cleanup"
        hint="Closed tasks keep their checkout for a while. Worktrees with uncommitted changes are never touched."
      >
        <SegmentedRow
          setting="worktreeGc.mode"
          label="When a closed task’s worktree is old"
          value={settings.worktreeGc.mode}
          options={[
            { value: 'off', label: 'Keep' },
            { value: 'propose', label: 'Suggest' },
            { value: 'auto', label: 'Delete' },
          ]}
          onChange={(mode) => patch({ worktreeGc: { ...settings.worktreeGc, mode } })}
        />
        <Row
          setting="worktreeGc.afterDays"
          label="Old means"
          readOnlyValue={`${settings.worktreeGc.afterDays} days after closing`}
        >
          <CommitInput
            aria-label="Old means"
            className="w-20 flex-none"
            type="number"
            min={1}
            max={730}
            disabled={settings.worktreeGc.mode === 'off'}
            value={settings.worktreeGc.afterDays}
            onChange={(event) =>
              patch({
                worktreeGc: {
                  ...settings.worktreeGc,
                  afterDays: clampInt(event.target.value, 1, 730, 14),
                },
              })
            }
          />
          <span className="settings-micro">days after closing</span>
        </Row>
      </Section>
      <Section title="Task assistant">
        <SwitchRow
          setting="issues.assistantEnabled"
          label="Keep a summary on each task"
          description="Runs on each person’s background model when a task changes."
          value={settings.issues.assistantEnabled}
          onChange={(value) => patch({ issues: { ...settings.issues, assistantEnabled: value } })}
        />
        <LinearRow linear={linear} />
      </Section>
    </>
  )
})

function LinearRow({ linear }: { linear: LinearSecret | undefined }) {
  const description = 'Lets you and the superagent find Linear issues to link to tasks.'
  if (linear?.state.status !== 'available')
    return (
      <Row
        label="Linear"
        description={description}
        readOnly
        readOnlyValue={linear?.state.status === 'loading' ? 'Loading…' : 'Ask an admin'}
      />
    )
  const presence = linear.state.rows.find((row) => row.key === 'integrations.linearApiKey')
  return (
    <SecretRow
      setting="integrations.linearApiKey"
      label="Linear"
      description={description}
      present={presence?.present === true}
      fingerprint={presence?.fingerprint}
      pending={linear.busy}
      error={linear.error}
      onSave={linear.onSet}
      onRemove={async () => {
        await linear.onClear()
      }}
    />
  )
}
