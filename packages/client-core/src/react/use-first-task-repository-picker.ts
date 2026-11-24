import type { GitRepositoryWire } from '@podium/model/browser'
import { useMemo, useState } from 'react'
import {
  firstTaskRepositoryChoices,
  firstTaskRepositoryIdentity,
  rankFirstTaskRepositories,
} from '../new-task'
import type { RepoView } from '../values/types'

/** The single first-task picker owns the order for each menu opening. */
export function useFirstTaskRepositoryPicker(
  repos: GitRepositoryWire[],
  repositoryUsage: ReadonlyMap<string, number>,
) {
  // Stored on picker open: identities and recency stay still; metadata stays live.
  const [repoOrder, setRepoOrder] = useState<readonly string[] | null>(null)
  const liveRepoChoices = useMemo(() => firstTaskRepositoryChoices(repos), [repos])
  const rankingUsage = repoOrder === null ? repositoryUsage : undefined
  const repoChoices = useMemo(() => {
    if (repoOrder === null)
      return rankFirstTaskRepositories(repos, rankingUsage ?? new Map(), liveRepoChoices)
    const positions = new Map(repoOrder.map((id, position) => [id, position]))
    const choices = new Array<RepoView | undefined>(repoOrder.length)
    for (const repo of liveRepoChoices) {
      const position = positions.get(firstTaskRepositoryIdentity(repo))
      if (position !== undefined) choices[position] = repo
    }
    return choices.filter((repo): repo is RepoView => repo !== undefined)
  }, [repoOrder, liveRepoChoices, rankingUsage, repos])
  const onOpenChange = (open: boolean) =>
    setRepoOrder(
      open
        ? rankFirstTaskRepositories(repos, repositoryUsage, liveRepoChoices).map(
            firstTaskRepositoryIdentity,
          )
        : null,
    )
  return { repoChoices, onOpenChange }
}
