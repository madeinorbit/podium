/**
 * The base-branch menu for the Repositories harness (POD-6267): the shipping
 * `BaseBranchMenuContent`, fed fixture choices instead of the settings record
 * and server write that `RepoBaseBranchMenu` reads. Imported by relative path so
 * the harness alias on `@/lib/BaseBranchMenu` does not point it back here.
 */
import type { MachineId } from '@podium/model/browser'
import type { JSX } from 'react'
import { BaseBranchMenuContent } from '../src/lib/BaseBranchMenu'

export function RepoBaseBranchMenu(props: {
  repoId: string
  path: string
  machineId?: MachineId | undefined
  onDone: () => void
  align?: 'start' | 'end'
}): JSX.Element {
  return (
    <BaseBranchMenuContent
      heading="Base branch"
      current={props.repoId === 'repo-podium' ? 'dev/mw' : null}
      choices={['dev/mw', 'main', 'release']}
      fallback={{ label: 'Use Podium default (main)' }}
      note="New tasks here branch from it and land on it. Existing tasks keep theirs."
      onSave={async () => {}}
      onDone={props.onDone}
      align={props.align}
    />
  )
}
