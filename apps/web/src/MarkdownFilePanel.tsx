// apps/web/src/MarkdownFilePanel.tsx
import type { EditorView } from '@codemirror/view'
import { EditorView as CMView } from '@codemirror/view'
import { Columns2, Eye, Pencil, Save, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { canSave } from './editor-save'
import { MD_MODE_MAP_KEY, readFilePanelMode, writeFilePanelMode } from './file-panel-mode'
import { type FileScope, scopeKey } from './file-scope'
import { useIsMobile } from './hooks/use-is-mobile'
import { MarkdownPreview } from './MarkdownPreview'
import { SourceEditor } from './SourceEditor'
import { type BlockPos, lineForTop, topForLine } from './scroll-sync'
import { useStoreSelector } from './store'
import { useFileDocument } from './useFileDocument'

type Mode = 'preview' | 'source' | 'split'

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

/** One open file rendered as a workspace panel. Markdown files default to a rendered
 *  preview with Preview/Source/Split modes; other files render the source editor as
 *  before. */
export function MarkdownFilePanel({
  scope,
  path,
  onClose,
}: {
  scope: FileScope
  path: string
  onClose: () => void
}): JSX.Element {
  const doc = useFileDocument(scope, path)
  const uiState = useStoreSelector((s) => s.uiState)
  const md = isMarkdown(path)
  const mobile = useIsMobile()
  const tabId = `file:${scopeKey(scope)}:${path}`
  const [mode, setMode] = useState<Mode>(
    () => readFilePanelMode(uiState, MD_MODE_MAP_KEY, tabId) ?? (md ? 'preview' : 'source'),
  )
  const viewRef = useRef<EditorView | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)

  // Persist mode per tab; collapse split → source on mobile (no room for two panes).
  useEffect(() => {
    writeFilePanelMode(uiState, MD_MODE_MAP_KEY, tabId, mode)
  }, [uiState, tabId, mode])
  useEffect(() => {
    if (mobile && mode === 'split') setMode('source')
  }, [mobile, mode])

  // Split-mode scroll sync: map the editor's top visible line <-> the preview's
  // top visible block via data-source-line anchors. A guard flag prevents the two
  // scroll handlers from ping-ponging.
  useEffect(() => {
    if (mode !== 'split') return
    const view = viewRef.current
    const preview = previewScrollRef.current
    if (!view || !preview) return

    const blocks = (): BlockPos[] => {
      const top = preview.getBoundingClientRect().top - preview.scrollTop
      return Array.from(preview.querySelectorAll<HTMLElement>('[data-source-line]')).map((el) => ({
        line: Number(el.getAttribute('data-source-line')) || 1,
        top: el.getBoundingClientRect().top - top,
      }))
    }

    let lock = false
    const release = (): void => {
      lock = false
    }

    const onEditorScroll = (): void => {
      if (lock) return
      lock = true
      const line = view.state.doc.lineAt(
        view.lineBlockAtHeight(view.scrollDOM.scrollTop).from,
      ).number
      preview.scrollTop = topForLine(blocks(), line)
      requestAnimationFrame(release)
    }
    const onPreviewScroll = (): void => {
      if (lock) return
      lock = true
      const line = lineForTop(blocks(), preview.scrollTop)
      const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
      view.dispatch({ effects: CMView.scrollIntoView(pos, { y: 'start' }) })
      requestAnimationFrame(release)
    }

    view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })
    return () => {
      view.scrollDOM.removeEventListener('scroll', onEditorScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
    }
  }, [mode, doc.content])

  const handleClose = (): void => {
    if (doc.dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    onClose()
  }

  const showSource = !md || mode === 'source' || mode === 'split'
  const showPreview = md && (mode === 'preview' || mode === 'split')
  const fileKey = `${scopeKey(scope)}:${path}:${doc.reloadNonce}`

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
            <ModeButton
              active={mode === 'preview'}
              onClick={() => setMode('preview')}
              title="Preview"
            >
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
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="text-muted-foreground"
        >
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
                sessionId={scope.kind === 'session' ? scope.sessionId : ''}
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
