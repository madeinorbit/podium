import type { EditorView } from '@codemirror/view'
import { Columns2, Eye, Pencil, Save, X } from 'lucide-react'
import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
import { assetUrl } from './asset-url'
import { canSave } from './editor-save'
import { scopeKey, type FileScope } from './file-scope'
import { useIsMobile } from './hooks/use-is-mobile'
import {
  buildStaticHtmlPreview,
  linkedStylesheetPathsForStaticHtml,
} from './html-preview-transform'
import { SourceEditor } from './SourceEditor'
import { useStore } from './store'
import { useFileDocument } from './useFileDocument'

type Mode = 'preview' | 'source' | 'split'

const MODE_KEY = (id: string): string => `podium.htmlmode:${id}`

function loadMode(id: string): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY(id))
    return v === 'preview' || v === 'source' || v === 'split' ? v : 'preview'
  } catch {
    return 'preview'
  }
}

function dirOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '/'
}

export function HtmlFilePanel({
  scope,
  path,
  onClose,
}: {
  scope: FileScope
  path: string
  onClose: () => void
}): JSX.Element {
  const { httpOrigin, readFileScoped } = useStore()
  const doc = useFileDocument(scope, path)
  const mobile = useIsMobile()
  const tabId = `file:${scopeKey(scope)}:${path}`
  const [mode, setMode] = useState<Mode>(() => loadMode(tabId))
  const [cssTextByPath, setCssTextByPath] = useState<Record<string, string>>({})
  const viewRef = useRef<EditorView | null>(null)
  const fileDir = dirOf(path)

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

  const stylesheetPaths = useMemo(
    () => (doc.status === 'ready' ? linkedStylesheetPathsForStaticHtml(doc.content, fileDir) : []),
    [doc.status, doc.content, fileDir],
  )
  const stylesheetPathKey = stylesheetPaths.join('\n')

  useEffect(() => {
    let cancelled = false
    setCssTextByPath({})
    if (doc.status !== 'ready' || stylesheetPaths.length === 0) return

    void (async () => {
      const next: Record<string, string> = {}
      await Promise.all(
        stylesheetPaths.map(async (cssPath) => {
          const result = await readFileScoped(scope, cssPath)
          if (!cancelled && result.ok && result.content !== undefined)
            next[cssPath] = result.content
        }),
      )
      if (!cancelled) setCssTextByPath(next)
    })()

    return () => {
      cancelled = true
    }
  }, [doc.status, stylesheetPathKey, readFileScoped, scope])

  const srcDoc = useMemo(
    () =>
      buildStaticHtmlPreview({
        html: doc.content,
        fileDir,
        resolveAsset: (baseDir, src) =>
          scope.kind === 'session'
            ? assetUrl({ httpOrigin, sessionId: scope.sessionId, fileDir: baseDir, src })
            : null,
        readTextAsset: (absPath) => cssTextByPath[absPath],
      }),
    [doc.content, fileDir, httpOrigin, scope, cssTextByPath],
  )

  const handleClose = (): void => {
    if (doc.dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    onClose()
  }

  const showSource = mode === 'source' || mode === 'split'
  const showPreview = mode === 'preview' || mode === 'split'
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
        <div className="p-4 text-sm text-muted-foreground/60">Loading...</div>
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
            <div className="flex min-w-0 flex-1 bg-white">
              <iframe
                title="Rendered HTML preview"
                sandbox=""
                srcDoc={srcDoc}
                className="h-full min-h-0 w-full flex-1 border-0 bg-white"
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
