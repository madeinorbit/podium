// apps/web/src/MarkdownFilePanel.tsx
import type { EditorView } from '@codemirror/view'
import { Columns2, Eye, Pencil, Save, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { canSave } from './editor-save'
import { useIsMobile } from './hooks/use-is-mobile'
import { MarkdownPreview } from './MarkdownPreview'
import { SourceEditor } from './SourceEditor'
import { useFileDocument } from './useFileDocument'

type Mode = 'preview' | 'source' | 'split'

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

const MODE_KEY = (id: string): string => `podium.mdmode:${id}`
function loadMode(id: string, fallback: Mode): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY(id))
    return v === 'preview' || v === 'source' || v === 'split' ? v : fallback
  } catch {
    return fallback
  }
}

/** One open file rendered as a workspace panel. Markdown files default to a rendered
 *  preview with Preview/Source/Split modes; other files render the source editor as
 *  before. */
export function MarkdownFilePanel({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string
  path: string
  onClose: () => void
}): JSX.Element {
  const doc = useFileDocument(sessionId, path)
  const md = isMarkdown(path)
  const mobile = useIsMobile()
  const tabId = `file:${sessionId}:${path}`
  const [mode, setMode] = useState<Mode>(() => loadMode(tabId, md ? 'preview' : 'source'))
  const viewRef = useRef<EditorView | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)

  // Persist mode per tab; collapse split → source on mobile (no room for two panes).
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY(tabId), mode)
    } catch {
      /* best-effort */
    }
  }, [tabId, mode])
  useEffect(() => {
    if (mobile && mode === 'split') setMode('source')
  }, [mobile, mode])

  const handleClose = (): void => {
    if (doc.dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    onClose()
  }

  const showSource = !md || mode === 'source' || mode === 'split'
  const showPreview = md && (mode === 'preview' || mode === 'split')
  const fileKey = `${sessionId}:${path}:${doc.reloadNonce}`

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {path}
          {doc.dirty && (
            <span className="ml-1 text-amber-500" aria-label="unsaved changes">
              ●
            </span>
          )}
        </span>
        {md && (
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <ModeButton active={mode === 'preview'} onClick={() => setMode('preview')} title="Preview">
              <Eye size={13} />
            </ModeButton>
            <ModeButton active={mode === 'source'} onClick={() => setMode('source')} title="Source">
              <Pencil size={13} />
            </ModeButton>
            {!mobile && (
              <ModeButton active={mode === 'split'} onClick={() => setMode('split')} title="Split">
                <Columns2 size={13} />
              </ModeButton>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => void doc.save()}
          disabled={!canSave({ editable: doc.editable, dirty: doc.dirty, saving: doc.saving })}
          aria-label="Save"
          title="Save (⌘S)"
          className="text-muted-foreground disabled:opacity-30"
        >
          <Save size={14} />
        </button>
        <button type="button" onClick={handleClose} aria-label="Close" className="text-muted-foreground">
          <X size={16} />
        </button>
      </div>

      {doc.status === 'error' ? (
        <div className="p-4 text-sm text-muted-foreground">{doc.message}</div>
      ) : doc.status === 'loading' ? (
        <div className="p-4 text-sm text-muted-foreground/60">Loading…</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {showSource && (
            <div className={`flex min-w-0 flex-1 ${showPreview ? 'border-r border-border' : ''}`}>
              <SourceEditor
                key={fileKey}
                path={path}
                initialContent={doc.content}
                editable={doc.editable}
                onChange={doc.setContent}
                onSave={() => void doc.save()}
                viewRef={viewRef}
              />
            </div>
          )}
          {showPreview && (
            <div className="flex min-w-0 flex-1">
              <MarkdownPreview
                sessionId={sessionId}
                path={path}
                content={doc.content}
                scrollRef={previewScrollRef}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-6 w-6 items-center justify-center rounded ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
