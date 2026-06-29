import { ChevronUp, File as FileIcon, Folder, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatAppError } from './AppErrorPage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useStore } from './store'

type Entry = { name: string; isDir: boolean }

/** Join a directory and a child name into an absolute path (paths are POSIX here). */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export function FileBrowserModal({
  root,
  machineId,
  title,
  onClose,
}: {
  root: string
  machineId?: string
  title: string
  onClose: () => void
}): JSX.Element {
  const { listDir, openFileInWorktree } = useStore()
  const isMobile = useIsMobile()
  const [path, setPath] = useState(root)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null)
  const resolvedRootRef = useRef<string | null>(null)

  const load = useCallback(
    async (next: string) => {
      setLoading(true)
      setError(null)
      setEntries([])
      try {
        const r = await listDir({ machineId, root, path: next })
        if (!r.ok) {
          setError(r.error ?? 'Could not open directory')
          return
        }
        if (resolvedRootRef.current === null) {
          resolvedRootRef.current = r.path
          setResolvedRoot(r.path)
        }
        setPath(r.path)
        setEntries(r.entries)
      } catch (e) {
        setError(formatAppError(e, 'Could not open directory'))
      } finally {
        setLoading(false)
      }
    },
    [listDir, machineId, root],
  )

  useEffect(() => {
    void load(root)
  }, [load, root])

  const atRoot = resolvedRoot == null || path === resolvedRoot
  const parentCandidate = path.slice(0, path.lastIndexOf('/')) || '/'
  const parent = resolvedRoot && parentCandidate.startsWith(resolvedRoot) ? parentCandidate : (resolvedRoot ?? root)

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="gap-0 border-b border-border px-3.5 pt-3.5 pb-2.5 pr-10">
          <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {title}
          </DialogTitle>
          <div className="mt-1 break-words text-[13px] font-medium text-foreground">{path}</div>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={atRoot || loading}
            onClick={() => void load(parent)}
            aria-label="Up"
            title="Up"
          >
            <ChevronUp size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={loading}
            onClick={() => void load(path)}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
        {error && (
          <div className="border-b border-border px-3.5 py-2 text-xs text-destructive">{error}</div>
        )}
        <div className="min-h-[180px] flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
          {loading && <div className="p-3 text-xs text-muted-foreground/70">Loading…</div>}
          {!loading && entries.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">Empty.</div>
          )}
          {!loading &&
            entries.map((entry) => {
              const abs = joinPath(path, entry.name)
              return (
                <Button
                  variant="ghost"
                  size="default"
                  className="h-auto w-full justify-start gap-2.5 px-2 py-2 text-left font-normal text-foreground"
                  key={abs}
                  disabled={loading}
                  onClick={() => {
                    if (entry.isDir) {
                      void load(abs)
                    } else {
                      openFileInWorktree({ machineId, root, path: abs })
                      onClose()
                    }
                  }}
                >
                  {entry.isDir ? <Folder size={16} /> : <FileIcon size={16} />}
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.name}
                  </span>
                </Button>
              )
            })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
