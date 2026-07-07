import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { BlockNoteView } from '@blocknote/mantine'
import { useCreateBlockNote } from '@blocknote/react'
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Copy,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useConfirm } from '@/hooks/use-confirm'
import { cn } from '@/lib/utils'
import { useStore } from './store'

/**
 * Specs — a living, nested spec that humans and agents co-author (pspec v1).
 *
 * Layout: tree sidebar (all components of the spec, project root at the top)
 * + a BlockNote WYSIWYG editor for the selected component. Every node is a
 * "component" with a stable id (SP-xxxx) that code references as [spec:SP-xxxx]
 * and other components link to as <a href="#spec:SP-xxxx">.
 */

const ROOT_ID = 'SP-root'

interface SpecMeta {
  id: string
  title: string
  parent: string
  order: number
  status: 'active' | 'superseded' | 'draft'
  updatedAt: number
}

interface SearchHit {
  id: string
  title: string
  snippet: string
}

/** Track the app's dark mode (the `.dark` class on <html>) for the editor theme. */
function useIsDark(): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const obs = new MutationObserver(notify)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'))
}

export function SpecsView(): JSX.Element {
  const { trpc, repos } = useStore()
  const confirm = useConfirm()
  const isDark = useIsDark()

  const repoPaths = useMemo(() => [...new Set(repos.map((r) => r.path))], [repos])
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const activeRepo = repoPath && repoPaths.includes(repoPath) ? repoPath : (repoPaths[0] ?? null)

  const [components, setComponents] = useState<SpecMeta[]>([])
  const [selectedId, setSelectedId] = useState<string>(ROOT_ID)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const refreshTree = useCallback(async (): Promise<void> => {
    if (!activeRepo) return
    const list = await trpc.specs.list.query({ repoPath: activeRepo })
    setComponents(list)
  }, [trpc, activeRepo])

  useEffect(() => {
    setSelectedId(ROOT_ID)
    void refreshTree().catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to load spec')
    })
  }, [refreshTree])

  // ── Editor: one BlockNote instance, re-fed on selection change. ──────────
  const editor = useCreateBlockNote()
  // Suppress onChange-driven saves while we programmatically replace content.
  const feeding = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The component the current editor content belongs to — saves must target
  // this id even if the selection has already moved on.
  const loadedId = useRef<string | null>(null)

  const selected = components.find((c) => c.id === selectedId)

  const persistBody = useCallback(
    async (id: string): Promise<void> => {
      if (!activeRepo) return
      const body = await editor.blocksToFullHTML(editor.document)
      setSaving(true)
      try {
        await trpc.specs.save.mutate({ repoPath: activeRepo, id, body })
      } finally {
        setSaving(false)
      }
    },
    [trpc, activeRepo, editor],
  )

  const flushPendingSave = useCallback((): void => {
    if (saveTimer.current && loadedId.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      void persistBody(loadedId.current).catch(() => toast.error('Failed to save spec'))
    }
  }, [persistBody])

  // Load the selected component's body into the editor.
  useEffect(() => {
    if (!activeRepo) return
    flushPendingSave()
    let cancelled = false
    setLoading(true)
    void (async () => {
      const spec = await trpc.specs.get.query({ repoPath: activeRepo, id: selectedId })
      if (cancelled) return
      feeding.current = true
      const blocks = await editor.tryParseHTMLToBlocks(spec?.body ?? '<p></p>')
      if (!cancelled) {
        editor.replaceBlocks(editor.document, blocks)
        loadedId.current = selectedId
      }
      feeding.current = false
      setLoading(false)
    })().catch(() => {
      if (!cancelled) setLoading(false)
      toast.error('Failed to load component')
    })
    return () => {
      cancelled = true
      feeding.current = false
    }
  }, [trpc, activeRepo, selectedId, editor, flushPendingSave])

  const onEditorChange = useCallback((): void => {
    if (feeding.current || !loadedId.current) return
    const id = loadedId.current
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void persistBody(id).catch(() => toast.error('Failed to save spec'))
    }, 800)
  }, [persistBody])

  // Flush the debounced save when leaving the view entirely.
  useEffect(() => flushPendingSave, [flushPendingSave])

  // Clicking a #spec:SP-xxxx interlink inside the editor navigates within Specs.
  const onEditorClick = useCallback((e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    const href = anchor?.getAttribute('href')
    const ref = href?.match(/^#?spec:(.+)$/)?.[1]
    if (ref) {
      e.preventDefault()
      setSelectedId(ref)
    }
  }, [])

  // ── Search ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeRepo || !query.trim()) {
      setHits(null)
      return
    }
    const t = setTimeout(() => {
      void trpc.specs.search
        .query({ repoPath: activeRepo, query })
        .then(setHits)
        .catch(() => setHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [trpc, activeRepo, query])

  // ── Tree mutations ────────────────────────────────────────────────────────
  const addChild = useCallback(
    async (parent: string): Promise<void> => {
      if (!activeRepo) return
      try {
        const created = await trpc.specs.create.mutate({
          repoPath: activeRepo,
          title: 'New component',
          parent,
        })
        await refreshTree()
        setSelectedId(created.id)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create component')
      }
    },
    [trpc, activeRepo, refreshTree],
  )

  const removeSelected = useCallback(async (): Promise<void> => {
    if (!activeRepo || !selected || selected.id === ROOT_ID) return
    const ok = await confirm({
      title: `Delete "${selected.title}"?`,
      description: `Removes pspec/${selected.id}.html. Code comments referencing [spec:${selected.id}] will dangle.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await trpc.specs.remove.mutate({ repoPath: activeRepo, id: selected.id })
      setSelectedId(selected.parent || ROOT_ID)
      await refreshTree()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete component')
    }
  }, [trpc, activeRepo, selected, confirm, refreshTree])

  const saveMeta = useCallback(
    async (patch: { title?: string; status?: SpecMeta['status'] }): Promise<void> => {
      if (!activeRepo || !selected) return
      try {
        await trpc.specs.save.mutate({ repoPath: activeRepo, id: selected.id, ...patch })
        await refreshTree()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save')
      }
    },
    [trpc, activeRepo, selected, refreshTree],
  )

  if (!activeRepo) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Add a repository to start a spec.
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1">
      {/* ── Tree sidebar ── */}
      <aside className="flex w-[280px] flex-none flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <BookOpenText size={16} className="text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-semibold">Specs</span>
          {repoPaths.length > 1 && (
            <Select value={activeRepo} onValueChange={setRepoPath}>
              <SelectTrigger
                aria-label="Repository"
                className="ml-auto h-6 w-auto max-w-[140px] gap-1 border-0 px-1 text-[11px] text-muted-foreground shadow-none"
              >
                <span className="truncate">{activeRepo.split('/').pop()}</span>
              </SelectTrigger>
              <SelectContent align="end">
                {repoPaths.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {p.split('/').pop()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="relative mx-3 mb-2">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search spec…"
            className="h-7 pl-7 text-[13px]"
            aria-label="Search spec"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {hits !== null ? (
            hits.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            ) : (
              hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    setSelectedId(h.id)
                    setQuery('')
                  }}
                >
                  <div className="text-[13px] font-medium">{h.title}</div>
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">{h.snippet}</div>
                </button>
              ))
            )
          ) : (
            <SpecTree
              components={components}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAddChild={(id) => void addChild(id)}
            />
          )}
        </div>
      </aside>

      {/* ── Editor ── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {selected && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <input
              key={selected.id}
              defaultValue={selected.title}
              disabled={selected.id === ROOT_ID}
              aria-label="Component title"
              className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground disabled:opacity-100"
              onBlur={(e) => {
                const title = e.target.value.trim()
                if (title && title !== selected.title) void saveMeta({ title })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            {saving && (
              <LoaderCircle
                size={14}
                className="animate-spin text-muted-foreground"
                aria-label="Saving"
              />
            )}
            <button
              type="button"
              title={`Copy code reference [spec:${selected.id}]`}
              className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                void navigator.clipboard.writeText(`[spec:${selected.id}]`)
                toast.success(`Copied [spec:${selected.id}]`)
              }}
            >
              {selected.id}
              <Copy size={11} aria-hidden="true" />
            </button>
            <Select
              value={selected.status}
              onValueChange={(v) => void saveMeta({ status: v as SpecMeta['status'] })}
            >
              <SelectTrigger
                aria-label="Component status"
                className="h-6 w-auto gap-1 border-0 px-1.5 text-[11px] text-muted-foreground shadow-none"
              >
                <span
                  className={cn(
                    'capitalize',
                    selected.status === 'draft' && 'text-amber-500',
                    selected.status === 'superseded' && 'line-through',
                  )}
                >
                  {selected.status}
                </span>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="active" className="text-xs">
                  active
                </SelectItem>
                <SelectItem value="draft" className="text-xs">
                  draft
                </SelectItem>
                <SelectItem value="superseded" className="text-xs">
                  superseded
                </SelectItem>
              </SelectContent>
            </Select>
            {selected.id !== ROOT_ID && (
              <button
                type="button"
                title="Delete component"
                aria-label="Delete component"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                onClick={() => void removeSelected()}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: click delegation for spec: links inside the editor */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users activate links natively; this only intercepts mouse clicks on spec: anchors */}
        <div
          className={cn('min-h-0 flex-1 overflow-y-auto py-4', loading && 'opacity-50')}
          onClick={onEditorClick}
        >
          <BlockNoteView
            editor={editor}
            theme={isDark ? 'dark' : 'light'}
            onChange={onEditorChange}
          />
        </div>
      </main>
    </div>
  )
}

// ── Tree ─────────────────────────────────────────────────────────────────────

function SpecTree({
  components,
  selectedId,
  onSelect,
  onAddChild,
}: {
  components: SpecMeta[]
  selectedId: string
  onSelect: (id: string) => void
  onAddChild: (id: string) => void
}): JSX.Element {
  const children = useMemo(() => {
    const map = new Map<string, SpecMeta[]>()
    for (const c of components) {
      if (c.id === ROOT_ID) continue
      const list = map.get(c.parent) ?? []
      list.push(c)
      map.set(c.parent, list)
    }
    return map
  }, [components])
  const root = components.find((c) => c.id === ROOT_ID)
  if (!root) return <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
  return (
    <TreeNode
      node={root}
      childrenOf={children}
      depth={0}
      selectedId={selectedId}
      onSelect={onSelect}
      onAddChild={onAddChild}
    />
  )
}

function TreeNode({
  node,
  childrenOf,
  depth,
  selectedId,
  onSelect,
  onAddChild,
}: {
  node: SpecMeta
  childrenOf: Map<string, SpecMeta[]>
  depth: number
  selectedId: string
  onSelect: (id: string) => void
  onAddChild: (id: string) => void
}): JSX.Element {
  const kids = childrenOf.get(node.id) ?? []
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-md py-1 pr-1 text-[13px]',
          selectedId === node.id
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          className={cn('flex-none rounded p-0.5', kids.length === 0 && 'invisible')}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            node.status === 'draft' && 'italic',
            node.status === 'superseded' && 'line-through opacity-60',
          )}
          onClick={() => onSelect(node.id)}
        >
          {node.title}
        </button>
        <button
          type="button"
          title="Add sub-component"
          aria-label={`Add sub-component under ${node.title}`}
          className="invisible flex-none rounded p-0.5 hover:bg-border group-hover:visible"
          onClick={() => onAddChild(node.id)}
        >
          <Plus size={12} aria-hidden="true" />
        </button>
      </div>
      {open &&
        kids.map((k) => (
          <TreeNode
            key={k.id}
            node={k}
            childrenOf={childrenOf}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            onAddChild={onAddChild}
          />
        ))}
    </div>
  )
}
