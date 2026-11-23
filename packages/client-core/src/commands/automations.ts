import type { PodiumClientApi } from '../api'
import type { AutomationsCommands } from './automations-types'
import type { CommandDeps } from './context'
import { reportCommandFailure } from './failures'
import type { CommandWrites } from './writes'
export function createAutomationsCommands<TApi extends PodiumClientApi>(
  _rt: CommandDeps<TApi>,
  shared: CommandWrites,
): AutomationsCommands<TApi> {
  const { records } = shared
  const commands: AutomationsCommands<TApi> = {
    // An agent's request, decided (POD-6674): a generic edit of its effect
    // record, made against the revision the person was shown. Queued and
    // painted at once; the first decision wins on the server, and the record's
    // status follows on every device.
    decideApproval: async (id, decision, revision) => {
      await records.edit({ kind: 'effect', id }, { decision }, revision)
    },
    // A trigger subscription on or off, or removed (POD-6676): generic edits of
    // its record, by its feed id. Queued and painted at once, offline too;
    // every device of mine shows the change from the record.
    setSubscriptionEnabled: async (id, enabled) => {
      await records.edit({ kind: 'subscription', id }, { enabled })
    },
    removeSubscription: async (id) => {
      await records.remove({ kind: 'subscription', id })
    },
  }
  return {
    decideApproval: reportCommandFailure(commands.decideApproval, shared.reportFailure),
    setSubscriptionEnabled: reportCommandFailure(
      commands.setSubscriptionEnabled,
      shared.reportFailure,
    ),
    removeSubscription: reportCommandFailure(commands.removeSubscription, shared.reportFailure),
  }
}
