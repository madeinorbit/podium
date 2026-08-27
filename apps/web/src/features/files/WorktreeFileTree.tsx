import { shallowEqual } from '@podium/client-core/store'
import { basename } from '@podium/client-core/viewmodels'
import type { MachineId } from '@podium/model'
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { formatAppError } from '@/app/AppErrorPage'
import { useClickIntent } from '@/app/click-intent'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FileTypeIcon } from './file-icon'

type Entry = { name: string; isDir: boolean }

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.isDir !== b.isDir
      ? a.isDir
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

function relativeToRoot(root: string, path: string): string {
  if (!path.startsWith('/')) return path
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function absoluteInRoot(root: string, path: string): string {
  return path.startsWith('/') ? path : joinPath(root, path)
}

/**
 * ONE ROW OF THE TREE, on the flight deck's open contract (POD-788).
 *
 * A file opens the way a session does: one click is a GLANCE — a temporary tab
 * the next glance replaces — and a double click (or Enter) keeps it. The dock's
 * file tree is the same kind of surface as the deck's spine, a list you walk
 * looking for the thing you actually want, and before this every step of that
 * walk left a permanent tab behind. Editing the file promotes it too, via the
 * deck-wide `usePreviewPromotion` — nothing you have typed into can be a glance.
 *
 * A directory has no second gesture: the click toggles it immediately, because a
 * fold that waits 260ms for a double click that never comes reads as lag.
 */
function EntryRow({
  entry,
  depth,
  open,
  onToggle,
  onOpen,
}: {
  entry: Entry
  depth: number
  open: boolean
  onToggle: () => void
  onOpen: (permanent: boolean) => void
}): JSX.Element {
  const intent = useClickIntent()
  const dot = entry.name.startsWith('.')
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-7 w-full justify-start gap-1.5 px-2 text-left font-normal ${
        dot ? 'text-muted-foreground/60' : 'text-foreground'
      }`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      title={entry.isDir ? entry.name : `${entry.name} — double-click to keep the tab open`}
      // One click previews, two keep it (see `useClickIntent`). Enter is the
      // keyboard's double click and must not go through the click path, so it
      // cancels the browser's synthesised click first.
      onClick={() => {
        if (entry.isDir) {
          onToggle()
          return
        }
        intent.press(
          () => onOpen(false),
          () => onOpen(true),
        )
      }}
      onKeyDown={(event) => {
        if (entry.isDir || event.key !== 'Enter') return
        event.preventDefault()
        intent.commit(() => onOpen(true))
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
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
        {entry.name}
      </span>
    </Button>
  )
}

function SearchResultRow({
  id,
  root,
  path,
  selected,
  onSelect,
  onOpen,
}: {
  id: string
  root: string
  path: string
  selected: boolean
  onSelect: () => void
  onOpen: (permanent: boolean) => void
}): JSX.Element {
  const intent = useClickIntent()
  const relative = relativeToRoot(root, path)
  const slash = relative.lastIndexOf('/')
  const name = slash === -1 ? relative : relative.slice(slash + 1)
  const dir = slash === -1 ? '' : relative.slice(0, slash)
  return (
    <Button
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      variant="ghost"
      size="sm"
      className={`h-auto min-h-9 w-full justify-start gap-2 px-2 py-1.5 text-left font-normal text-foreground ${
        selected ? 'bg-muted' : ''
      }`}
      title={`${relative} · double-click to keep the tab open`}
      onMouseMove={onSelect}
      onClick={() =>
        intent.press(
          () => onOpen(false),
          () => onOpen(true),
        )
      }
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        intent.commit(() => onOpen(true))
      }}
    >
      <FileTypeIcon name={name} size={15} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs leading-4">{name}</span>
        {dir && (
          <span className="block truncate font-mono text-[10px] leading-3 text-muted-foreground/70">
            {dir}
          </span>
        )}
      </span>
    </Button>
  )
}

/** Lazy collapsible file tree over a worktree checkout. State is keyed per-root
 *  by the parent (via `key={root}`), so switching sessions re-roots cleanly. */
export function WorktreeFileTree({
  root,
  machineId,
}: {
  root: string
  machineId?: MachineId
}): JSX.Element {
  const { listDir, openFileInWorktree, trpc } = useStoreSelector(
    (s) => ({ listDir: s.listDir, openFileInWorktree: s.openFileInWorktree, trpc: s.trpc }),
    shallowEqual,
  )
  // dir path → its listed entries (presence = loaded); separate expanded set.
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchPaths, setSearchPaths] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [activeSearchIndex, setActiveSearchIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const searchSeq = useRef(0)
  const searchListId = useId()
  const searchInputId = useId()

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

  useEffect(() => {
    const trimmed = query.trim()
    const seq = ++searchSeq.current
    if (!trimmed) {
      setSearchPaths([])
      setActiveSearchIndex(0)
      setSearching(false)
      setSearchError(false)
      return
    }
    setSearching(true)
    setSearchPaths([])
    setSearchError(false)
    const timer = setTimeout(() => {
      trpc.files.search
        .query({ root, query: trimmed, limit: 50, ...(machineId ? { machineId } : {}) })
        .then((result) => {
          if (searchSeq.current !== seq) return
          setSearchPaths(result.paths)
          setActiveSearchIndex(0)
          setSearching(false)
        })
        .catch(() => {
          if (searchSeq.current !== seq) return
          setSearchPaths([])
          setActiveSearchIndex(0)
          setSearching(false)
          setSearchError(true)
        })
    }, 120)
    return () => clearTimeout(timer)
  }, [machineId, query, root, trpc])

  useEffect(() => {
    if (!query.trim() || !searchPaths[activeSearchIndex]) return
    document
      .getElementById(`${searchListId}-${activeSearchIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeSearchIndex, query, searchListId, searchPaths])

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

  const openSearchPath = (path: string, permanent: boolean): void => {
    openFileInWorktree({
      machineId,
      root,
      path: absoluteInRoot(root, path),
      permanent,
    })
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
      const open = expanded.has(abs)
      return (
        <div key={abs}>
          <EntryRow
            entry={entry}
            depth={depth}
            open={open}
            onToggle={() => toggleDir(abs)}
            onOpen={(permanent) => openFileInWorktree({ machineId, root, path: abs, permanent })}
          />
          {entry.isDir && open && renderDir(abs, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (
          event.key !== '/' ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          (event.target as HTMLElement).matches('input, textarea, select') ||
          (event.target as HTMLElement).isContentEditable
        )
          return
        event.preventDefault()
        searchRef.current?.focus()
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1" title={root}>
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium">
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
      <div className="border-b border-border p-2">
        <label htmlFor={searchInputId} className="relative block">
          <Search
            size={13}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
          />
          <span className="sr-only">Search files</span>
          <Input
            id={searchInputId}
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                setQuery('')
              } else if (event.key === 'ArrowDown' && searchPaths.length > 0) {
                event.preventDefault()
                setActiveSearchIndex((index) => Math.min(index + 1, searchPaths.length - 1))
              } else if (event.key === 'ArrowUp' && searchPaths.length > 0) {
                event.preventDefault()
                setActiveSearchIndex((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter' && searchPaths[activeSearchIndex]) {
                event.preventDefault()
                openSearchPath(searchPaths[activeSearchIndex], true)
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchPaths.length > 0}
            aria-controls={searchPaths.length > 0 ? searchListId : undefined}
            aria-activedescendant={
              query.trim() && searchPaths[activeSearchIndex]
                ? `${searchListId}-${activeSearchIndex}`
                : undefined
            }
            placeholder="Search files  /"
            autoComplete="off"
            spellCheck={false}
            className="h-7 rounded-md border-border bg-muted/20 pr-7 pl-7 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label="Clear file search"
              className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </label>
        <span className="sr-only" role="status">
          {query.trim()
            ? searching
              ? 'Searching files'
              : searchError
                ? 'File search is unavailable'
                : `${searchPaths.length} matching files${
                    searchPaths[activeSearchIndex]
                      ? `. ${relativeToRoot(root, searchPaths[activeSearchIndex])} selected`
                      : ''
                  }`
            : ''}
        </span>
      </div>
      {error && (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-busy={searching}>
        {query.trim() ? (
          searching ? (
            <div className="px-2 py-2 text-xs text-muted-foreground/70">Searching…</div>
          ) : searchError ? (
            <div className="px-2 py-2 text-xs text-destructive">File search is unavailable.</div>
          ) : searchPaths.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground/70">No matching files.</div>
          ) : (
            <div id={searchListId} role="listbox" aria-label="Matching files">
              {searchPaths.map((path, index) => (
                <SearchResultRow
                  key={path}
                  id={`${searchListId}-${index}`}
                  root={root}
                  path={path}
                  selected={activeSearchIndex === index}
                  onSelect={() => setActiveSearchIndex(index)}
                  onOpen={(permanent) => openSearchPath(path, permanent)}
                />
              ))}
            </div>
          )
        ) : (
          renderDir(root, 0)
        )}
      </div>
    </div>
  )
}
