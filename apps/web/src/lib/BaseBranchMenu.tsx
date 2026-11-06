/**
 * THE BRANCH PICKER FOR A REPOSITORY'S BASE BRANCH AND A TASK'S PARENT [POD-2065].
 *
 * One menu body for the sidebar's project ⋯ menu, Settings → Repositories and
 * the task page. The web has no route that lists a checkout's branches, so the
 * list is what the client already knows (`baseBranchChoices`) and the field takes
 * any other name. Whatever `onSave` rejects with is shown under the field with
 * the menu still open: for a repository that is the server's own refusal
 * (`repos.setDefaultParentBranch` is a direct call that checks the branch
 * exists); the task page's edit is queued, so it rejects only on enqueue.
 */

import { useStoreHandle } from '@podium/client-core/react'
import { here } from '@podium/client-graph/lookup'
import {
  baseBranchChoices,
  podiumDefaultLabel,
  repositoryScanOf,
} from '@podium/client-graph/repo-base-branch'
import { repoWrites } from '@podium/commands/fleet-synced'
import type { MachineId } from '@podium/model/browser'
import { Check } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSettingsRecord } from './settings-record'

const LIST_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp'])

export interface BaseBranchMenuProps {
  heading: string
  /** The stored value; `null` when the default applies. */
  current: string | null
  choices: readonly string[]
  /** The row that clears the value, when it can be cleared. */
  fallback?: { label: string }
  note?: string
  /** Resolves when saved; a rejection's message is shown in the menu. */
  onSave: (branch: string | null) => Promise<void>
  onDone: () => void
  align?: 'start' | 'end'
  anchor?: Element | null
}

/** The menu body. Render it inside an open `DropdownMenu`. */
export function BaseBranchMenuContent({
  heading,
  current,
  choices,
  fallback,
  note,
  onSave,
  onDone,
  align = 'start',
  anchor,
}: BaseBranchMenuProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typed = draft.trim()
  const shown = typed
    ? choices.filter((name) => name.toLowerCase().includes(typed.toLowerCase()))
    : choices

  const save = async (branch: string | null): Promise<void> => {
    if (saving) return
    if (branch === current) {
      onDone()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(branch)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DropdownMenuContent
      align={align}
      anchor={anchor}
      className="w-64"
      data-testid="base-branch-menu"
    >
      <DropdownMenuGroup>
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        <div className="mx-[5px] mt-[3px] mb-[5px]">
          <Input
            autoFocus
            value={draft}
            placeholder="Branch name…"
            aria-label="Branch name"
            disabled={saving}
            spellCheck={false}
            className="h-[26px] rounded-md border-hairline-soft bg-background font-mono text-[11.5px] placeholder:font-sans placeholder:text-text-faint focus-visible:border-hairline-soft focus-visible:ring-2 focus-visible:ring-ring/40 md:text-[11.5px]"
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed) {
                e.preventDefault()
                void save(typed)
              }
              // Escape closes the menu and the arrows move into the list (so the
              // keyboard reaches "Use Podium default"); every other key stays
              // in the field, out of the items' typeahead.
              if (!LIST_KEYS.has(e.key)) e.stopPropagation()
            }}
          />
        </div>
        {shown.map((name) => (
          <DropdownMenuItem
            key={name}
            closeOnClick={false}
            disabled={saving}
            onClick={() => void save(name)}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{name}</span>
            {current === name && (
              <Check className="ml-auto size-3 flex-none text-text-faint" aria-label="Current" />
            )}
          </DropdownMenuItem>
        ))}
        {typed && !choices.includes(typed) && (
          <DropdownMenuItem closeOnClick={false} disabled={saving} onClick={() => void save(typed)}>
            <span className="min-w-0 flex-1 truncate">
              Use <span className="font-mono text-[11.5px]">{typed}</span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      {fallback && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem closeOnClick={false} disabled={saving} onClick={() => void save(null)}>
            <span className="min-w-0 flex-1 truncate">{fallback.label}</span>
            {current === null && (
              <Check className="ml-auto size-3 flex-none text-text-faint" aria-label="Current" />
            )}
          </DropdownMenuItem>
        </>
      )}
      {error ? (
        <p
          role="alert"
          className="px-[5px] pt-1.5 pb-1 text-[11px] leading-snug text-destructive"
          data-testid="base-branch-error"
        >
          {error}
        </p>
      ) : note ? (
        <p className="px-[5px] pt-1.5 pb-1 text-[10.5px] leading-snug text-text-faint">{note}</p>
      ) : null}
    </DropdownMenuContent>
  )
}

/** The Podium-wide default parent branch; `undefined` until settings load. */
export function usePodiumDefaultParentBranch(): string | undefined {
  const trpc = useStoreHandle<Trpc>().access.trpc
  const read = useCallback(() => trpc.settings.get.query(), [trpc])
  const settings = useSettingsRecord(read)?.model
  return settings ? (settings.gitWorkflow?.defaultParentBranch ?? '') : undefined
}

/**
 * A repository's base-branch menu: reads the stored value off the shared repo
 * model and writes through `repos.setDefaultParentBranch`. Mount it only while
 * its menu is open — it reads the settings record.
 */
export const RepoBaseBranchMenu = observer(function RepoBaseBranchMenu({
  repoId,
  path,
  machineId,
  onDone,
  align,
  anchor,
}: {
  /** The logical repository: what the menu reads and writes, never a path alone. */
  repoId: string
  path: string
  /** The checkout's machine when the caller has it; else a checkout of `repoId`'s. */
  machineId?: MachineId | undefined
  onDone: () => void
  align?: 'start' | 'end'
  anchor?: Element | null
}): JSX.Element {
  const pool = useWorklistPool()
  const trpc = useStoreHandle<Trpc>().access.trpc
  const podiumDefault = usePodiumDefaultParentBranch()
  const scan = pool ? repositoryScanOf(pool, repoId, path) : undefined
  const repo = pool ? here(pool.model('repo', repoId)) : undefined
  const current = repo?.defaultParentBranch ?? null
  // The write names one checkout of this repo: the caller's, or a reported one.
  const target = machineId
    ? { path, machineId }
    : scan?.machineId
      ? { path: scan.path, machineId: scan.machineId }
      : undefined
  return (
    <BaseBranchMenuContent
      heading="Base branch"
      current={current}
      choices={baseBranchChoices(scan, current)}
      fallback={{
        label:
          podiumDefault === undefined
            ? 'Use Podium default'
            : `Use Podium default (${podiumDefaultLabel(podiumDefault)})`,
      }}
      note="New tasks here branch from it and land on it. Existing tasks keep theirs."
      onSave={async (branch) => {
        if (!target) throw new Error('No machine reports this repository right now.')
        await repoWrites(trpc).setDefaultParentBranch.mutate({ ...target, branch })
      }}
      onDone={onDone}
      align={align}
      anchor={anchor}
    />
  )
})
