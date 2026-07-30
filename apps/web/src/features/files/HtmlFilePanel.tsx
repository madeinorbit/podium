import type { EditorView } from '@codemirror/view'
import { shallowEqual } from '@podium/client-core/store'
import { Columns2, Eye, Pencil, Save, X } from 'lucide-react'
import { type JSX, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { scopedAssetUrl } from '@/lib/asset-url'
import { type FileScope, scopeKey } from '@/lib/file-scope'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { canSave } from './editor-save'
import { HTML_MODE_MAP_KEY, readFilePanelMode, writeFilePanelMode } from './file-panel-mode'
import {
  buildStaticHtmlPreview,
  linkedStylesheetPathsForStaticHtml,
} from './html-preview-transform'
import { SourceEditor } from './SourceEditor'
import { useFileDocument } from './useFileDocument'

type Mode = 'preview' | 'source' | 'split'

function dirOf(path: string): string {
  // Artifact-scope paths are relpaths ([spec:SP-0fc9] #441): a slash-less entry
  // lives at the artifact root, so its dir is '' (not the path itself).
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i) || '/'
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
  const { httpOrigin, readFileScoped, uiState } = useStoreSelector(
    (s) => ({ httpOrigin: s.httpOrigin, readFileScoped: s.readFileScoped, uiState: s.uiState }),
    shallowEqual,
  )
  const doc = useFileDocument(scope, path)
  const saveFeedbackId = useId()
  const mobile = useIsMobile()
  const tabId = `file:${scopeKey(scope)}:${path}`
  const [mode, setMode] = useState<Mode>(
    () => readFilePanelMode(uiState, HTML_MODE_MAP_KEY, tabId) ?? 'preview',
  )
  const [cssTextByPath, setCssTextByPath] = useState<Record<string, string>>({})
  const viewRef = useRef<EditorView | null>(null)
  const fileDir = dirOf(path)

  useEffect(() => {
    writeFilePanelMode(uiState, HTML_MODE_MAP_KEY, tabId, mode)
  }, [uiState, tabId, mode])

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

  // Artifacts are deliverables an agent built for the user to click ([spec:SP-0fc9]); every
  // other scope is just some .html on disk. Only the former earns script execution.
  const allowScripts = scope.kind === 'artifact'
  const assetOrigin = httpOrigin || (typeof window === 'undefined' ? '' : window.location.origin)

  const srcDoc = useMemo(
    () =>
      buildStaticHtmlPreview({
        html: doc.content,
        fileDir,
        resolveAsset: (baseDir, src) =>
          scopedAssetUrl({ httpOrigin, scope, fileDir: baseDir, src }),
        readTextAsset: (absPath) => cssTextByPath[absPath],
        allowScripts,
        assetOrigin,
      }),
    [doc.content, fileDir, httpOrigin, scope, cssTextByPath, allowScripts, assetOrigin],
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
        <span
          id={saveFeedbackId}
          role={doc.saveFeedback?.kind === 'error' ? 'alert' : 'status'}
          className={`w-20 truncate text-right text-[10px] ${
            doc.saveFeedback?.kind === 'error' ? 'text-destructive' : 'text-success'
          }`}
          title={doc.saveFeedback?.message}
        >
          {doc.saveFeedback?.message ?? ''}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void doc.save()}
          disabled={!canSave({ editable: doc.editable, dirty: doc.dirty, saving: doc.saving })}
          pending={doc.saving}
          pendingLabel={<span className="sr-only">Saving file…</span>}
          aria-label={doc.saving ? 'Saving file…' : 'Save'}
          aria-describedby={saveFeedbackId}
          title="Save (⌘S)"
        >
          <Save size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={handleClose}
          aria-label="Close"
          title="Close"
        >
          <X size={16} />
        </Button>
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
                // allow-scripts WITHOUT allow-same-origin ⇒ opaque origin: no app DOM, no
                // session cookie, no storage. Modals/popups/forms/top-navigation/downloads
                // stay ungranted; the injected CSP blocks network egress.
                sandbox={allowScripts ? 'allow-scripts' : ''}
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
      data-pressable
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
