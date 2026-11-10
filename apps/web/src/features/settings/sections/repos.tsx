import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import {
  type SettingsCheckout,
  SettingsRepositories,
  type SettingsRepository,
  type SettingsWorktree,
} from '@podium/client-graph/settings-repositories'
import { repoWrites } from '@podium/commands/fleet-synced'
import { isValidPrefix } from '@podium/protocol'
import { ChevronDown, ChevronRight, GitBranch, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { toast } from 'sonner'
import { openAddProject } from '@/app/desktop-menu'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { RepoBaseBranchMenu, usePodiumDefaultParentBranch } from '@/lib/BaseBranchMenu'
import { REF_PREFIXES_CHANGED_EVENT } from '@/lib/ref-activation'
import { cn } from '@/lib/utils'
import { SettingsPageActions, useSettingsFrame } from '../settings-frame'
import { ConfirmInline, Row, Section, useSettingsPermitted, ValueRow } from './shared'

const createRepositories = (pool: MobxPool) => new SettingsRepositories(pool)

/** The list stays compact; edits and checkout details live in a pane takeover. */
export const ReposSection = observer(function ReposSection({
  podiumDefault,
}: {
  podiumDefault: string | undefined
}) {
  const view = useOpeningView(useWorklistPool(), createRepositories)
  const canManage = useSettingsPermitted('records.instancePreferences.edit')
  const rows = view?.loaded ? view.rows : undefined
  return (
    <>
      {canManage && (
        <SettingsPageActions>
          <Button variant="outline" size="sm" onClick={openAddProject}>
            <Plus aria-hidden="true" />
            Add project
          </Button>
        </SettingsPageActions>
      )}
      <Section list>
        {rows === undefined ? (
          <div className="settings-list-note" role="status" aria-label="Loading projects">
            <span className="settings-prose">Loading projects…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="settings-list-note">
            <p className="settings-label">No projects yet</p>
            <p className="settings-prose mt-1">Add a repository for Podium to work in.</p>
          </div>
        ) : (
          rows.map((row) => <ProjectRow key={row.key} row={row} podiumDefault={podiumDefault} />)
        )}
      </Section>
    </>
  )
})

const ProjectRow = observer(function ProjectRow({
  row,
  podiumDefault,
}: {
  row: SettingsRepository
  podiumDefault: string | undefined
}) {
  const { openTakeover } = useSettingsFrame()
  return (
    <button
      type="button"
      className="settings-list-row flex w-full items-center gap-3 text-left hover:bg-muted/40"
      onClick={() => openTakeover({ title: row.name, content: <ProjectDetail row={row} /> })}
      data-testid="settings-repo-row"
    >
      <span className="settings-micro flex size-10 flex-none items-center justify-center rounded-lg bg-muted font-mono font-semibold">
        {row.prefix ?? '—'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="settings-label block truncate">{row.name}</span>
        <span className="settings-micro mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch size={12} aria-hidden="true" />
            <span className="truncate font-mono">
              {row.defaultParentBranch ?? (podiumDefault?.trim() || 'main')}
            </span>
            {!row.defaultParentBranch && <span>default</span>}
          </span>
          <span aria-hidden="true">·</span>
          <span>{row.checkouts.length} {row.checkouts.length === 1 ? 'checkout' : 'checkouts'}</span>
          <span aria-hidden="true">·</span>
          <span>{row.worktreeCount} {row.worktreeCount === 1 ? 'worktree' : 'worktrees'}</span>
        </span>
      </span>
      <ChevronRight size={15} aria-hidden="true" className="flex-none text-muted-foreground" />
    </button>
  )
})

const ProjectDetail = observer(function ProjectDetail({ row }: { row: SettingsRepository }) {
  const podiumDefault = usePodiumDefaultParentBranch()
  const canManage = useSettingsPermitted('records.instancePreferences.edit')
  const [showWorktrees, setShowWorktrees] = useState(false)
  return (
    <>
      <Section>
        <PrefixRow row={row} canManage={canManage} />
        <Row
          label="Base branch"
          description={
            row.defaultParentBranch
              ? 'New tasks here branch from it and land on it. Existing tasks keep theirs.'
              : `Uses the workspace default (${podiumDefault?.trim() || 'each repo’s main'}).`
          }
          readOnly={!canManage}
          readOnlyValue={<BranchLabel row={row} podiumDefault={podiumDefault} />}
        >
          <BaseBranchField row={row} podiumDefault={podiumDefault} />
        </Row>
        <ValueRow
          label="Remote"
          value={<span className="settings-value break-all">{row.origin ?? 'Local only'}</span>}
        />
      </Section>
      <Section title="Checkouts" hint="Where this repository lives on each machine." list>
        {row.checkouts.map((checkout) => <CheckoutRow key={checkout.scan.id} checkout={checkout} />)}
      </Section>
      <Section
        title="Worktrees"
        hint={`${row.worktreeCount} task ${row.worktreeCount === 1 ? 'worktree' : 'worktrees'}.`}
        action={row.worktreeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showWorktrees}
            onClick={() => setShowWorktrees((value) => !value)}
          >
            {showWorktrees ? 'Show less' : 'Show all'}
          </Button>
        )}
      >
        {showWorktrees && row.checkouts.flatMap((checkout) => checkout.worktrees.map((worktree) => (
          <WorktreeRow
            key={`${checkout.scan.id}:${worktree.path}`}
            checkout={checkout}
            worktree={worktree}
          />
        )))}
      </Section>
      <Section title="Remove">
        <RemoveProject row={row} canManage={canManage} />
      </Section>
    </>
  )
})

const PrefixRow = observer(function PrefixRow({
  row,
  canManage,
}: {
  row: SettingsRepository
  canManage: boolean
}) {
  const trpc = useSettingsTrpc()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const prefix = draft ?? row.prefix ?? ''
  const changed = prefix !== (row.prefix ?? '')
  const valid = isValidPrefix(prefix)
  const cancel = () => {
    setDraft(null)
    setError(null)
  }
  const save = async () => {
    const checkout = row.writeCheckout
    if (!changed || !valid || saving || !canManage || !checkout) return
    setSaving(true)
    setError(null)
    try {
      await repoWrites(trpc).setPrefix.mutate({
        path: checkout.path,
        prefix,
        ...(checkout.machineId ? { machineId: checkout.machineId } : {}),
      })
      window.dispatchEvent(new Event(REF_PREFIXES_CHANGED_EVENT))
      cancel()
      toast('Saved')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <Row
        label="Task prefix"
        description={<>Tasks read <code>{prefix || 'POD'}-1</code>, <code>{prefix || 'POD'}-2</code>… Two to five letters.</>}
        readOnly={!canManage}
        readOnlyValue={row.prefix ?? 'None'}
        error={error}
        pending={saving}
      >
        <Input
          className="w-24 font-mono uppercase"
          aria-label={`Prefix for ${row.name}`}
          data-testid="repo-prefix-input"
          maxLength={5}
          spellCheck={false}
          autoComplete="off"
          disabled={!row.writeCheckout}
          value={prefix}
          onChange={(event) => {
            setDraft(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              cancel()
            }
          }}
        />
      </Row>
      {changed && canManage && (
        <div className="settings-list-note" role="note">
          <p className="settings-prose">
            {row.prefix ? <>References already written as <b>{row.prefix}-13</b> will stop linking.</> : 'This prefix will number the project’s tasks.'}
          </p>
          {!valid && <p className="settings-prose mt-1">A prefix is 2 to 5 letters, A to Z.</p>}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={!valid || saving || !row.writeCheckout}
              pending={saving}
              pendingLabel="Changing…"
              onClick={() => void save()}
              data-testid="repo-prefix-save"
            >
              Change to {prefix || '…'}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}
    </>
  )
})

const BranchLabel = observer(function BranchLabel({ row, podiumDefault }: {
  row: SettingsRepository
  podiumDefault: string | undefined
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <GitBranch size={13} aria-hidden="true" className="flex-none" />
      <span className="settings-value truncate">{row.defaultParentBranch ?? (podiumDefault?.trim() || 'main')}</span>
      {!row.defaultParentBranch && <span className="settings-micro">default</span>}
    </span>
  )
})

const BaseBranchField = observer(function BaseBranchField({ row, podiumDefault }: {
  row: SettingsRepository
  podiumDefault: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const checkout = row.writeCheckout
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={
        <Button
          variant="outline"
          className="w-full justify-between font-normal"
          disabled={!checkout}
          aria-label={`Base branch for ${row.name}`}
          data-testid="repo-base-branch"
        >
          <BranchLabel row={row} podiumDefault={podiumDefault} />
          <ChevronDown size={13} aria-hidden="true" />
        </Button>
      } />
      {open && checkout && (
        <RepoBaseBranchMenu
          repoId={row.repoId}
          path={checkout.path}
          machineId={checkout.machineId ?? undefined}
          align="end"
          onDone={() => setOpen(false)}
        />
      )}
    </DropdownMenu>
  )
})

const CheckoutRow = observer(function CheckoutRow({ checkout }: { checkout: SettingsCheckout }) {
  const online = checkout.machineOnline
  const state = online === null ? 'Machine unknown' : online ? 'Online' : 'Offline'
  return (
    <div className="settings-list-row flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="settings-label">{checkout.machineName ?? 'Unknown machine'}</p>
        <p className="settings-micro mt-1 break-all font-mono">{checkout.path}</p>
      </div>
      <span className="settings-micro flex flex-none items-center gap-1.5">
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', online ? 'bg-success' : 'bg-muted-foreground/40')} />
        {state}
      </span>
    </div>
  )
})

const WorktreeRow = observer(function WorktreeRow({ checkout, worktree }: {
  checkout: SettingsCheckout
  worktree: SettingsWorktree
}) {
  return (
    <div className="settings-list-row">
      <p className="settings-label font-mono">{worktree.branch ?? 'Detached HEAD'}</p>
      <p className="settings-micro mt-1 break-all">
        {checkout.machineName ?? 'Unknown machine'} · <span className="font-mono">{worktree.path}</span>
        {worktree.prunable && <span className="text-warning"> · Folder missing</span>}
        {worktree.locked && <span> · Locked</span>}
      </p>
    </div>
  )
})

const RemoveProject = observer(function RemoveProject({ row, canManage }: {
  row: SettingsRepository
  canManage: boolean
}) {
  const trpc = useSettingsTrpc()
  const { closeTakeover } = useSettingsFrame()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (pending || !canManage) return
    setPending(true)
    setError(null)
    try {
      // repos.remove unregisters ONE path. Include registered nested worktrees
      // too: the list deliberately folds those scans into their root checkout.
      const registrations = row.scans.map((scan) => ({
        path: scan.path,
        ...(scan.machineId ? { machineId: scan.machineId } : {}),
      }))
      for (const registration of registrations) await repoWrites(trpc).remove.mutate(registration)
      toast('Project removed')
      closeTakeover()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <Row
        label="Remove from Podium"
        description="Podium forgets the project. Files on disk and its tasks stay."
        readOnly={!canManage}
        readOnlyValue="Only admins can remove projects"
        error={!confirming ? error : null}
        pending={pending}
      >
        <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>Remove</Button>
      </Row>
      {confirming && canManage && (
        <ConfirmInline
          sentence={`Remove ${row.name} from Podium? Files on disk and its tasks stay.`}
          actionLabel="Remove"
          destructive
          pending={pending}
          error={error}
          onConfirm={remove}
          onCancel={() => { setConfirming(false); setError(null) }}
        />
      )}
    </>
  )
})
