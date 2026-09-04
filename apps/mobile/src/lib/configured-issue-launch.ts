import { spawnIssueAgent } from '@podium/client-core/viewmodels'
import {
  type LaunchPlan,
  launchConfigurationPatch,
  launchPlanCanSubmit,
} from './launch-configuration'

interface ConfiguredIssueApi {
  update: {
    mutate: (input: {
      id: string
      patch: ReturnType<typeof launchConfigurationPatch>
    }) => Promise<unknown>
  }
  addSession: { mutate: (input: { id: string }) => Promise<unknown> }
  start: { mutate: (input: { id: string }) => Promise<unknown> }
}

/** Persist one normalized profile, then spawn without guessing from replica checkout state. */
export async function startConfiguredIssue(
  issues: ConfiguredIssueApi,
  id: string,
  plan: LaunchPlan | null,
): Promise<void> {
  if (!launchPlanCanSubmit(plan)) {
    throw new Error(plan?.refusal ?? 'Launch configuration is still loading.')
  }
  await issues.update.mutate({ id, patch: launchConfigurationPatch(plan.configuration) })
  await spawnIssueAgent(issues, { id })
}
