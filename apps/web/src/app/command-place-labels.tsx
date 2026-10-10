import type { WorktreeView } from '@podium/client-core/values'
import { machinePathBasename } from '@podium/model/browser'
import { observer } from 'mobx-react-lite'

/** Candidate order is held for the query; each painted fact follows its model. */
export const CommandPlaceTitle = observer(function CommandPlaceTitle({ worktree }: { worktree: WorktreeView }) {
  return <>{worktree.branch ?? (machinePathBasename(worktree.path) || worktree.path)}</>
})
export const CommandPlaceHint = observer(function CommandPlaceHint({ worktree }: { worktree: WorktreeView & { readonly repoName?: string } }) {
  return <>{worktree.repoName}</>
})
