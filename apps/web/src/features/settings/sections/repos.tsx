/**
 * Repos — the registered repos with their human-facing ref prefixes (#474).
 * Shows every row from `repos.listDetailed` and lets the user edit a repo's
 * prefix inline (repos.setPrefix). Server-side validation (^[A-Z]{2,5}$ +
 * server-wide uniqueness) errors surface next to the editor; changing an
 * existing prefix warns that previously written refs stop resolving.
 */
import { isValidPrefix } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { REF_PREFIXES_CHANGED_EVENT } from '@/lib/ref-activation'
import { Section } from './shared'

/** One row from `repos.listDetailed`. */
export interface RepoDetailRow {
  machineId: string
  path: string
  originUrl?: string
  repoId?: string
  prefix: string | null
}

function repoName(path: string): string {
  return path.split('/').pop() ?? path
}

export function ReposSection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [rows, setRows] = useState<RepoDetailRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    trpc.repos.listDetailed
      .query()
      .then((r) => {
        if (!cancelled) setRows(r as RepoDetailRow[])
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  const save = async (row: RepoDetailRow, prefix: string): Promise<void> => {
    const updated = (await trpc.repos.setPrefix.mutate({
      path: row.path,
      prefix,
      machineId: row.machineId,
    })) as RepoDetailRow[]
    setRows(updated)
    // Tell the linkifiers' prefix sync to refetch — old refs stop resolving now.
    window.dispatchEvent(new Event(REF_PREFIXES_CHANGED_EVENT))
  }

  return (
    <Section
      title="Repositories"
      hint="Each registered repo has a short uppercase prefix used in human-facing ids like POD-13. Prefixes are unique across the server."
    >
      {loadError && <p className="py-1 text-[12px] text-destructive">{loadError}</p>}
      {!rows ? (
        !loadError && <p className="py-1 text-[12px] text-muted-foreground">Loading repos…</p>
      ) : rows.length === 0 ? (
        <p className="py-1 text-[12px] text-muted-foreground">No repositories registered.</p>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <RepoPrefixRow key={`${row.machineId}:${row.path}`} row={row} onSave={save} />
          ))}
        </div>
      )}
    </Section>
  )
}

function RepoPrefixRow({
  row,
  onSave,
}: {
  row: RepoDetailRow
  onSave: (row: RepoDetailRow, prefix: string) => Promise<void>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const startEdit = (): void => {
    setDraft(row.prefix ?? '')
    setError(null)
    setEditing(true)
  }

  const submit = async (): Promise<void> => {
    const prefix = draft.trim().toUpperCase()
    if (!isValidPrefix(prefix)) {
      setError('A prefix is 2–5 uppercase letters (A–Z).')
      return
    }
    if (prefix === row.prefix) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(row, prefix)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-border/60 border-b py-1.5 last:border-b-0">
      <div className="flex items-center gap-2.5 text-[13px]">
        <span className="min-w-0 flex-1 truncate" title={row.path}>
          <span className="text-foreground">{repoName(row.path)}</span>
          <span className="ml-2 text-[11px] text-muted-foreground">{row.path}</span>
        </span>
        {editing ? (
          <>
            <Input
              className="w-24 flex-none font-mono uppercase"
              value={draft}
              autoFocus
              maxLength={5}
              aria-label={`Prefix for ${repoName(row.path)}`}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <Button
              type="button"
              size="sm"
              className="flex-none"
              disabled={saving}
              onClick={() => void submit()}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-none"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="flex-none font-mono text-[12px] text-foreground">
              {row.prefix ?? <span className="text-muted-foreground">none</span>}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-none"
              onClick={startEdit}
            >
              {row.prefix ? 'Change…' : 'Set…'}
            </Button>
          </>
        )}
      </div>
      {editing && row.prefix && (
        <p className="mt-1 max-w-[60ch] text-[12px] text-warning">
          Previously written refs (e.g. {row.prefix}-13) will stop resolving.
        </p>
      )}
      {editing && error && (
        <p className="mt-1 max-w-[60ch] text-[12px] text-destructive">{error}</p>
      )}
    </div>
  )
}
