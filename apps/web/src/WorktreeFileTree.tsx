import { shallowEqual } from '@podium/client-core/store'
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatAppError } from './AppErrorPage'
import { basename } from './dock-panel'
import { FileTypeIcon } from './file-icon'
import { useStoreSelector } from './store'

type Entry = { name: string; isDir: boolean }

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
  )
}

/** Lazy collapsible file tree over a worktree checkout. State is keyed per-root
 *  by the parent (via `key={root}`), so switching sessions re-roots cleanly. */
export function WorktreeFileTree({
  root,
  machineId,
}: {
  root: string
  machineId?: string
}): JSX.Element {
  const { listDir, openFileInWorktree } = useStoreSelector(
    (s) => ({ listDir: s.listDir, openFileInWorktree: s.openFileInWorktree }),
    shallowEqual,
  )
  // dir path → its listed entries (presence = loaded); separate expanded set.
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (dir: string) => {
      setLoadingDirs((s) => new Set(s).add(dir))
      try {
        const r = await listDir({ machineId, root, path: dir })
        if (!r.ok) {
          setError(r.error ?? 'Could not open directory')
          return
        }
        setError(null)
        // Key by the requested dir (not r.path) so child lookups by joined path hit.
        setChildren((c) => ({ ...c, [dir]: sortEntries(r.entries) }))
      } catch (e) {
        setError(formatAppError(e, 'Could not open directory'))
      } finally {
        setLoadingDirs((s) => {
          const next = new Set(s)
          next.delete(dir)
          return next
        })
      }
    },
    [listDir, machineId, root],
  )

  useEffect(() => {
    void load(root)
  }, [load, root])

  const toggleDir = (dir: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(dir)) {
        next.delete(dir)
      } else {
        next.add(dir)
      }
      return next
    })
    if (children[dir] === undefined) void load(dir)
  }

  const refresh = () => {
    setChildren({})
    setExpanded(new Set())
    void load(root)
  }

  const renderDir = (dir: string, depth: number): JSX.Element[] => {
    const entries = children[dir]
    if (entries === undefined) {
      return [
        <div
          key={`${dir}:loading`}
          className="px-2 py-1 text-xs text-muted-foreground/70"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          Loading…
        </div>,
      ]
    }
    if (entries.length === 0) {
      return [
        <div
          key={`${dir}:empty`}
          className="px-2 py-1 text-xs text-muted-foreground/70"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          Empty.
        </div>,
      ]
    }
    return entries.map((entry) => {
      const abs = joinPath(dir, entry.name)
      const dot = entry.name.startsWith('.')
      const open = expanded.has(abs)
      return (
        <div key={abs}>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 w-full justify-start gap-1.5 px-2 text-left font-normal ${
              dot ? 'text-muted-foreground/60' : 'text-foreground'
            }`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => {
              if (entry.isDir) {
                toggleDir(abs)
              } else {
                openFileInWorktree({ machineId, root, path: abs })
              }
            }}
          >
            {entry.isDir ? (
              open ? (
                <ChevronDown size={13} className="flex-none" />
              ) : (
                <ChevronRight size={13} className="flex-none" />
              )
            ) : (
              <span className="w-[13px] flex-none" />
            )}
            {entry.isDir ? (
              open ? (
                <FolderOpen size={14} className="flex-none text-amber-300/80" />
              ) : (
                <Folder size={14} className="flex-none text-amber-300/80" />
              )
            ) : (
              <FileTypeIcon name={entry.name} />
            )}
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
              {entry.name}
            </span>
          </Button>
          {entry.isDir && open && renderDir(abs, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1" title={root}>
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">
            {basename(root)}
          </div>
          {/* Full directory path; leading side truncates so the tail stays readable. */}
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted-foreground/70"
            style={{ direction: 'rtl', textAlign: 'left' }}
          >
            <bdi>{root}</bdi>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={loadingDirs.size > 0}
          onClick={refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {error && (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{renderDir(root, 0)}</div>
    </div>
  )
}
