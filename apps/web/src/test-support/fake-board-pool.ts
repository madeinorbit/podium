import type { IssueViewModel } from '@podium/client-core/replica'
import { isFinished } from '@podium/model/browser'

/** A hand-made pool for board screen tests: `row` answers the board's own
 * questions, and each fixture issue stands in for its shared model with the
 * card fields at rest (no workers, no subtree rollup, no present sessions). */
export function fakeBoardPool(
  row: (entity: string, key: string) => unknown,
  lookup: (id: string) => IssueViewModel | undefined,
) {
  const views = new Map<string, unknown>()
  const models = new WeakMap<IssueViewModel, object>()
  const unknown = new Map<string, object>()
  return {
    row,
    notSaved: () => false,
    sources: {
      view: <T>(key: string, create: () => T): T => {
        if (!views.has(key)) views.set(key, create())
        return views.get(key) as T
      },
    },
    issueObject(id: string): object {
      const issue = lookup(id)
      if (!issue) {
        if (!unknown.has(id)) unknown.set(id, { id, finished: undefined })
        return unknown.get(id)!
      }
      let model = models.get(issue)
      if (!model) {
        model = {
          ...issue,
          finished: isFinished(issue),
          unread: issue.unread ?? false,
          confirmedWorkingAgents: 0,
          taskProgress: null,
          presentMembers: [],
        }
        models.set(issue, model)
      }
      return model
    },
  }
}
