// apps/web/src/MarkdownFilePanel.tsx

import type { EditorView } from '@codemirror/view'
import { EditorView as CMView } from '@codemirror/view'
import { useStoreHandle } from '@podium/client-core/react'
import {
  MD_MODE_MAP_KEY,
  readFilePanelMode,
  writeFilePanelMode,
} from '@podium/client-core/ui-state'
import { type FileScope, scopeKey } from '@podium/client-core/values'
import { asSessionId } from '@podium/model/browser'
import { Columns2, Eye, Flower2, Pencil, Save, X } from 'lucide-react'
import { type JSX, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { modChord } from '@/lib/mod-chord'
import { usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import { CalmMarkdownReader } from './CalmMarkdownReader'
import { DownloadFileButton } from './DownloadFileButton'
import { canSave } from './editor-save'
import { isMarkdownPath } from './file-kind'
import { MarkdownPreview } from './MarkdownPreview'
import { OpenInBrowserButton } from './OpenInBrowserButton'
import { SourceEditor } from './SourceEditor'
import { type BlockPos, lineForTop, topForLine } from './scroll-sync'
import { useFileScrollPosition } from './use-file-scroll-position'
import { useFileDocument } from './useFileDocument'

type Mode = 'preview' | 'source' | 'split'

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
  const worktree =
    scope.kind === 'worktree'
      ? { root: scope.root, ...(scope.machineId ? { machineId: scope.machineId } : {}) }
      : undefined
  const saveFeedbackId = useId()
  const { uiState } = useStoreHandle().access
  const md = isMarkdownPath(path)
  const mobile = useIsMobile()
  const [calmReading, setCalmReading] = useState(false)
  const closeCalmReading = useCallback(() => setCalmReading(false), [])
  const tabId = `file:${scopeKey(scope)}:${path}`
  // Per-tab mode is per-user REPLICATED: SUBSCRIBE, never seed. A `useState`
  // initializer read the map before the replica had the row, and the mount
  // effect then wrote that fallback back — so a stored mode arriving a moment
  // later lost last-writer-wins to a default nobody picked (POD-540).
  const mode = usePersistedUiValue(
    MD_MODE_MAP_KEY,
    // The shared parser reads a collection; hand it the SUBSCRIBED row so the
    // map's parsing stays in client-core and this panel stays a subscriber.
    useCallback(
      (raw: string | null): Mode =>
        readFilePanelMode({ get: () => raw }, MD_MODE_MAP_KEY, tabId) ??
        (md ? 'preview' : 'source'),
      [tabId, md],
    ),
  )
  const setMode = useCallback(
    (next: Mode): void => writeFilePanelMode(uiState, MD_MODE_MAP_KEY, tabId, next),
    [uiState, tabId],
  )
  const viewRef = useRef<EditorView | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  const showSource = !md || mode === 'source' || mode === 'split'
  const showPreview = md && (mode === 'preview' || mode === 'split')
  const sourceScroll = useFileScrollPosition(tabId, 'source', doc.status === 'ready' && showSource)
  const previewScroll = useFileScrollPosition(
    tabId,
    'preview',
    doc.status === 'ready' && showPreview,
  )
  const onSourceReady = useCallback(
    (view: EditorView) => sourceScroll(view.scrollDOM),
    [sourceScroll],
  )
  const onPreviewReady = useCallback(
    (node: HTMLDivElement | null) => {
      previewScrollRef.current = node
      previewScroll(node)
    },
    [previewScroll],
  )

  // Collapse split → source on mobile (no room for two panes).
  useEffect(() => {
    if (mobile && mode === 'split') setMode('source')
  }, [mobile, mode, setMode])

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
        {md && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setCalmReading(true)}
            disabled={doc.status !== 'ready'}
            aria-label="Enter calm reading mode"
            title="Calm reading mode"
          >
            <Flower2 size={14} aria-hidden="true" />
          </Button>
        )}
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
        <OpenInBrowserButton scope={scope} path={path} dirty={doc.dirty} />
        <DownloadFileButton scope={scope} path={path} dirty={doc.dirty} />
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
          title={`Save (${modChord('S')})`}
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
                onViewReady={onSourceReady}
              />
            </div>
          )}
          {showPreview && (
            <div className="flex min-w-0 flex-1">
              <MarkdownPreview
                sessionId={scope.kind === 'session' ? scope.sessionId : asSessionId('')}
                {...(worktree ? { worktree } : {})}
                path={path}
                content={doc.content}
                scrollRef={onPreviewReady}
              />
            </div>
          )}
        </div>
      )}
      {calmReading && doc.status === 'ready' && (
        <CalmMarkdownReader
          sessionId={scope.kind === 'session' ? scope.sessionId : asSessionId('')}
          {...(worktree ? { worktree } : {})}
          path={path}
          content={doc.content}
          onClose={closeCalmReading}
        />
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
