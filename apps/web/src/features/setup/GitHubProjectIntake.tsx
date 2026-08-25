import { shallowEqual } from '@podium/client-core/store'
import { GITHUB_PROJECT_INTAKE_DRAFT_KEY } from '@podium/client-core/ui-state'
import type { MachineWire } from '@podium/model'
import type { GitHubCliStatusWire, GitHubRepositoryWire } from '@podium/protocol'
import { Check, Copy, Download, ExternalLink, GitFork, RefreshCw, Search } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatAppError } from '@/app/AppErrorPage'
import { useStoreSelector } from '@/app/store'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SetupBusyOverlay, SetupError } from './SetupFeedback'

type IntakeMachine = Pick<MachineWire, 'id' | 'name' | 'online' | 'inventory'>
type Draft = { query: string; repository: string; destination: string }

const emptyDraft: Draft = { query: '', repository: '', destination: '' }

function readDraft(raw: string | null): Draft {
  if (!raw) return emptyDraft
  try {
    const value = JSON.parse(raw) as Partial<Draft>
    return {
      query: typeof value.query === 'string' ? value.query : '',
      repository: typeof value.repository === 'string' ? value.repository : '',
      destination: typeof value.destination === 'string' ? value.destination : '',
    }
  } catch {
    return emptyDraft
  }
}

function repoFolder(repository: string): string {
  return repository.split('/').pop() ?? 'repository'
}

export function GitHubProjectIntake({
  machine,
  homePath,
  onClone,
}: {
  machine: IntakeMachine | undefined
  homePath: string | undefined
  onClone: (repository: string, destination: string) => Promise<void>
}): JSX.Element {
  const { trpc, uiState } = useStoreSelector(
    (s) => ({ trpc: s.trpc, uiState: s.uiState }),
    shallowEqual,
  )
  const [draft, setDraftState] = useState<Draft>(() =>
    readDraft(uiState?.get(GITHUB_PROJECT_INTAKE_DRAFT_KEY) ?? null),
  )
  const [status, setStatus] = useState<GitHubCliStatusWire | null>(null)
  const [repositories, setRepositories] = useState<GitHubRepositoryWire[]>([])
  const [checking, setChecking] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const machineId = machine?.id
  const machineOnline = machine?.online === true
  const ghInventory = machine?.inventory?.tools.find((tool) => tool.name === 'gh')
  const knownMissing = ghInventory?.installed === false

  const setDraft = useCallback(
    (next: Draft) => {
      setDraftState(next)
      uiState?.set(GITHUB_PROJECT_INTAKE_DRAFT_KEY, JSON.stringify(next))
    },
    [uiState],
  )

  const refresh = useCallback(
    async (force = false) => {
      if (!machineOnline || !machineId) return
      if (knownMissing && !force) {
        setStatus({ state: 'missing' })
        setRepositories([])
        return
      }
      setChecking(true)
      setError(null)
      try {
        const result = await trpc.repos.githubList.query({ machineId })
        setStatus(result.status)
        setRepositories(result.repositories ?? [])
        setError(result.error ?? null)
      } catch (cause) {
        setError(formatAppError(cause, 'Could not check GitHub CLI'))
      } finally {
        setChecking(false)
      }
    },
    [knownMissing, machineId, machineOnline, trpc],
  )

  useEffect(() => {
    setStatus(null)
    setRepositories([])
    void refresh()
  }, [refresh])

  useEffect(() => {
    const refreshAfterRecovery = (): void => {
      void refresh(true)
    }
    window.addEventListener('focus', refreshAfterRecovery)
    return () => window.removeEventListener('focus', refreshAfterRecovery)
  }, [refresh])

  const filtered = useMemo(() => {
    const query = draft.query.trim().toLocaleLowerCase()
    if (!query) return repositories
    return repositories.filter((repo) =>
      `${repo.nameWithOwner} ${repo.description ?? ''}`.toLocaleLowerCase().includes(query),
    )
  }, [draft.query, repositories])

  const selected = repositories.find((repo) => repo.nameWithOwner === draft.repository)
  const canClone =
    machine?.online === true &&
    status?.state === 'ready' &&
    selected !== undefined &&
    draft.destination.trim().startsWith('/')

  function selectRepository(repository: GitHubRepositoryWire): void {
    const same = repository.nameWithOwner === draft.repository
    const destination =
      same && draft.destination
        ? draft.destination
        : homePath
          ? `${homePath.replace(/\/$/u, '')}/podium-repos/${repoFolder(repository.nameWithOwner)}`
          : draft.destination
    setDraft({ ...draft, repository: repository.nameWithOwner, destination })
  }

  async function clone(): Promise<void> {
    if (!canClone || !selected) return
    setCloning(true)
    setError(null)
    try {
      await onClone(selected.nameWithOwner, draft.destination.trim())
      uiState?.set(GITHUB_PROJECT_INTAKE_DRAFT_KEY, null)
    } catch (cause) {
      setError(formatAppError(cause, 'Could not clone repository'))
      setCloning(false)
    }
  }

  async function copySignIn(): Promise<void> {
    try {
      await navigator.clipboard.writeText('gh auth login')
      setCopied(true)
    } catch {
      setError('Copy failed. Run “gh auth login” in a terminal on this machine.')
    }
  }

  if (!machine) {
    return <p className="p-4 text-xs text-muted-foreground">Choose a machine to use GitHub.</p>
  }
  if (!machine.online) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        {machine.name} is offline. Your GitHub selection is saved.
      </p>
    )
  }

  const unavailable = checking || status?.state !== 'ready'

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={checking || cloning}>
      {(status?.state === 'missing' || (status === null && knownMissing)) && (
        <div className="m-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <GitFork size={16} /> GitHub CLI is not installed
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Install <code>gh</code> on {machine.name}, then check again. Your repository search and
            destination stay saved.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="https://cli.github.com/"
              target="_blank"
              rel="noreferrer"
              data-pressable
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Install GitHub CLI <ExternalLink size={14} />
            </a>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh(true)}
              disabled={checking}
            >
              <RefreshCw size={14} /> {checking ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        </div>
      )}

      {status?.state === 'logged-out' && (
        <div className="border-t border-[#2b2f37] bg-[#1f2329] px-6 py-[18px]">
          <div className="text-[14.5px] leading-none font-semibold text-[#f2f3f5]">
            Sign in to GitHub CLI
          </div>
          <p className="mt-[7px] text-[13px] leading-[1.5] text-[#9ba1ab]">
            Run this on {machine.name}. It opens GitHub's browser sign-in; Podium uses the resulting
            GitHub CLI login and never stores your token.
          </p>
          <div className="mt-[13px] flex h-11 items-center gap-3 rounded-[10px] bg-[#15171b] pr-3 pl-3.5 shadow-[inset_0_0_0_1px_#2f343d]">
            <code className="min-w-0 flex-1 select-all font-mono text-[13.5px] text-[#e6e8ec]">
              gh auth login
            </code>
            <Button
              size="sm"
              variant="ghost"
              className="h-[30px] rounded-lg border-0 px-3 text-[12.5px] font-semibold text-[#a8adb6] shadow-[inset_0_0_0_1px_#333842]"
              onClick={() => void copySignIn()}
            >
              <Copy size={14} /> {copied ? 'Copied' : 'Copy sign-in command'}
            </Button>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              className="h-[34px] rounded-[9px] border-0 bg-[#d9b477] px-[15px] text-[12.5px] font-semibold text-[#191308]"
              onClick={() => void refresh(true)}
              disabled={checking}
            >
              <RefreshCw size={14} /> {checking ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-[#2b2f37] px-6 py-3.5">
        <Search size={18} className="text-[#6f757f]" />
        <Input
          aria-label="Search GitHub repositories"
          aria-disabled={unavailable}
          readOnly={unavailable}
          className="h-9 rounded-[9px] border-0 bg-[#1b1e24] px-[13px] text-[13.5px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]"
          placeholder={checking ? 'Checking GitHub…' : 'Search accessible repositories'}
          value={draft.query}
          onChange={(event) => setDraft({ ...draft, query: event.currentTarget.value })}
        />
        {status?.state === 'ready' && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {status.login ? `Signed in as ${status.login}` : 'Signed in'}
          </span>
        )}
      </div>

      <div
        className={
          unavailable
            ? 'relative h-[214px] min-h-[214px] flex-1 overflow-hidden border-t border-[#272b33]'
            : 'min-h-[214px] flex-1 overflow-y-auto border-t border-[#272b33]'
        }
        aria-disabled={unavailable}
      >
        {unavailable && (
          <div className="flex h-full min-h-[214px] flex-col justify-center" role="status">
            <div className="absolute inset-0 opacity-[0.22]" aria-hidden="true">
              {['your-team/project', 'your-name/toolbox', 'your-org/application'].map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-3 border-t border-[#272b33] px-6 py-[15px] first:border-t-0"
                >
                  <GitFork size={18} className="text-[#8a9099]" />
                  <span className="font-mono text-[13.5px] text-[#8a9099]">{name}</span>
                </div>
              ))}
            </div>
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <div>
                <span className="mx-auto flex size-9 items-center justify-center rounded-[10px] bg-[#2a2418] text-[#d9b477] shadow-[inset_0_0_0_1px_#4a4331]">
                  <GitFork size={19} aria-hidden="true" />
                </span>
                <p className="mt-3 text-[15px] leading-none font-semibold text-[#f2f3f5]">
                  {checking ? 'Checking GitHub authorization…' : 'Authorize GitHub first'}
                </p>
                <p className="mt-2 text-[13px] leading-[1.5] text-[#9ba1ab]">
                  {status?.state === 'missing'
                    ? 'Install GitHub CLI before Podium can list repositories.'
                    : 'Podium can list and clone your repositories once the CLI is signed in.'}
                </p>
              </div>
            </div>
          </div>
        )}
        {status?.state === 'ready' && !checking && filtered.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">
            {repositories.length === 0
              ? 'No accessible repositories found.'
              : 'No repositories match your search.'}
          </p>
        )}
        {status?.state === 'ready' &&
          filtered.map((repo) => {
            const active = draft.repository === repo.nameWithOwner
            return (
              <Button
                key={repo.nameWithOwner}
                variant="ghost"
                className="h-auto w-full justify-start gap-2 px-2 py-2 text-left font-normal"
                aria-pressed={active}
                onClick={() => selectRepository(repo)}
              >
                {active ? (
                  <Check size={15} className="text-primary" />
                ) : (
                  <GitFork size={15} className="text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{repo.nameWithOwner}</span>
                  {repo.description && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {repo.description}
                    </span>
                  )}
                </span>
                {repo.isPrivate && (
                  <span className="rounded border border-border px-1.5 text-xs text-muted-foreground">
                    private
                  </span>
                )}
              </Button>
            )
          })}
      </div>

      <div className="border-t border-[#2b2f37] bg-[#1f2329] px-6 pt-[18px] pb-[22px]">
        <label
          htmlFor="github-clone-destination"
          className="text-[12.5px] leading-none font-semibold text-[#a8adb6]"
        >
          Where should Podium keep it?
        </label>
        <div className="mt-[11px] flex gap-3 max-sm:flex-col">
          <Input
            id="github-clone-destination"
            aria-label={`Clone destination on ${machine.name}`}
            aria-disabled={unavailable}
            readOnly={unavailable}
            value={draft.destination}
            placeholder="/home/user/podium-repos/project"
            className="h-[38px] rounded-[9px] border-0 bg-[#15171b] px-[13px] font-mono text-[13px] text-[#c3c8d0] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]"
            onChange={(event) => setDraft({ ...draft, destination: event.currentTarget.value })}
          />
          <Button
            disabled={!canClone || cloning}
            onClick={() => void clone()}
            className="h-[38px] rounded-[9px] border-0 bg-[#d9b477] px-[15px] text-[12.5px] font-semibold text-[#191308] disabled:bg-transparent disabled:text-[#5f656e] disabled:shadow-[inset_0_0_0_1px_#2b2f37] max-sm:w-full"
          >
            <Download size={15} />{' '}
            {cloning ? 'Preparing…' : selected ? 'Clone repository' : 'Choose a repository'}
          </Button>
        </div>
        {error && (
          <div className="mt-3">
            <SetupError>{error}</SetupError>
          </div>
        )}
      </div>
      {cloning && (
        <SetupBusyOverlay
          title="Cloning this repository…"
          detail={`Podium is cloning ${selected?.nameWithOwner ?? 'the repository'} into ${draft.destination}.`}
        />
      )}
    </div>
  )
}
