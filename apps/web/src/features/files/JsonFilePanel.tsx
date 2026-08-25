// apps/web/src/features/files/JsonFilePanel.tsx

import { codeFolding, foldAll, unfoldAll } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  JSON_MODE_MAP_KEY,
  readFilePanelMode,
  writeFilePanelMode,
} from '@podium/client-core/ui-state'
import { type FileScope, scopeKey } from '@podium/client-core/viewmodels'
import {
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  IndentIncrease,
  Pencil,
  Save,
  X,
} from 'lucide-react'
import { type JSX, useCallback, useDeferredValue, useId, useMemo, useRef } from 'react'
import { chordHint } from '@/app/desktop-commands'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import { canSave } from './editor-save'
import {
  describeShape,
  foldPlaceholderText,
  formatByteSize,
  inspectJsonDocument,
  type JsonFault,
  type JsonShape,
  withSourceLineEnding,
} from './json-document'
import { OpenInBrowserButton } from './OpenInBrowserButton'
import { SourceEditor } from './SourceEditor'
import { useFileDocument } from './useFileDocument'

/** Pretty is a VIEW, not an edit: it renders the file re-indented and read-only,
 *  and the file on disk is untouched until you press Format in Raw. */
type Mode = 'preview' | 'source'

/**
 * A collapsed object or array says what it is holding — `{ 12 keys }` rather than
 * `{ … }` — which is what makes collapse-all a way to READ a large document
 * instead of just a way to hide it. CodeMirror folds the inside of the brackets,
 * so the count lands between a visible pair.
 *
 * Module-level and frozen: `SourceEditor` rebuilds its view when this array's
 * identity changes.
 */
const jsonFoldSummaries: Extension[] = [
  codeFolding({
    preparePlaceholder: (state, range) => foldPlaceholderText(state.doc, range.from, range.to),
    placeholderDOM: (_view, onclick, prepared) => {
      const summary = typeof prepared === 'string' ? prepared : null
      const el = document.createElement('span')
      el.className = 'cm-foldPlaceholder'
      el.textContent = summary ?? '…'
      el.title = 'Expand'
      el.setAttribute('aria-label', summary ? `Collapsed: ${summary}. Expand` : 'Collapsed. Expand')
      el.onclick = onclick
      return el
    },
  }),
]

export function JsonFilePanel({
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
  const saveFeedbackId = useId()
  const tabId = `file:${scopeKey(scope)}:${path}`
  // Per-tab mode is per-user REPLICATED: SUBSCRIBE, never seed (POD-540). A file
  // family that only has two modes still reads the shared map, so a tab that was
  // last left in `split` by another panel resolves to the nearest thing here.
  const mode = usePersistedUiValue(
    JSON_MODE_MAP_KEY,
    useCallback(
      (raw: string | null): Mode =>
        readFilePanelMode({ get: () => raw }, JSON_MODE_MAP_KEY, tabId) === 'source'
          ? 'source'
          : 'preview',
      [tabId],
    ),
  )
  const setMode = useCallback(
    (next: Mode): void => writeFilePanelMode(uiState, JSON_MODE_MAP_KEY, tabId, next),
    [uiState, tabId],
  )

  const viewRef = useRef<EditorView | null>(null)
  const pendingReveal = useRef<number | null>(null)

  // Scanning is O(file) and the raw editor calls setContent on every keystroke.
  // Deferring it keeps typing at full speed in a large file and lets the strip
  // catch up a frame later — the reading is advisory, so late is fine. Format
  // never reads this: it re-scans the editor's own text at the moment it is asked.
  const scanned = useDeferredValue(doc.content)
  const json = useMemo(() => inspectJsonDocument(scanned), [scanned])
  const size = useMemo(() => formatByteSize(new TextEncoder().encode(scanned).length), [scanned])

  // Without a formatted rendering there is nothing for Pretty to show, so the file
  // itself is the only honest view.
  const effectiveMode: Mode = json.formatted === null ? 'source' : mode
  const showPretty = effectiveMode === 'preview' && json.formatted !== null

  const revealIn = useCallback((view: EditorView): void => {
    const at = pendingReveal.current
    if (at === null) return
    pendingReveal.current = null
    const pos = Math.min(at, view.state.doc.length)
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
  }, [])

  const goToFault = useCallback((): void => {
    if (!json.fault) return
    pendingReveal.current = json.fault.position
    const view = viewRef.current
    if (view) revealIn(view)
  }, [json.fault, revealIn])

  /** Make the indentation permanent. Dispatched INTO the editor rather than pushed
   *  through `setContent`, which is what puts it on the undo stack and leaves the
   *  save path (dirty → ⌘S) exactly as it is for a hand edit. */
  const format = useCallback((): void => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    const formatted = inspectJsonDocument(current).formatted
    if (formatted === null) return
    const next = withSourceLineEnding(current, formatted)
    if (next === current) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
  }, [])

  const fold = useCallback((all: boolean): void => {
    const view = viewRef.current
    if (!view) return
    ;(all ? foldAll : unfoldAll)(view)
    view.focus()
  }, [])

  const handleClose = (): void => {
    if (doc.dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    onClose()
  }

  const fileKey = `${scopeKey(scope)}:${path}:${doc.reloadNonce}`
  const canFormat = doc.editable && json.formatted !== null && !json.formattedAlready

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {path}
          {doc.dirty && (
            <span className="ml-1 text-amber-500" role="img" aria-label="unsaved changes">
              ●
            </span>
          )}
        </span>
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <ModeButton
            active={effectiveMode === 'preview'}
            disabled={json.formatted === null}
            onClick={() => setMode('preview')}
            title={
              json.formatted === null
                ? 'Pretty — unavailable while this file is not valid JSON'
                : 'Pretty — the file re-indented for reading; the file itself is unchanged'
            }
            label="Pretty"
          >
            <Braces size={13} />
          </ModeButton>
          <ModeButton
            active={effectiveMode === 'source'}
            onClick={() => setMode('source')}
            title="Raw — the file exactly as it is on disk, editable"
            label="Raw"
          >
            <Pencil size={13} />
          </ModeButton>
        </div>
        {showPretty ? (
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => fold(true)}
              aria-label="Collapse all"
              title="Collapse all"
            >
              <ChevronsDownUp size={14} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => fold(false)}
              aria-label="Expand all"
              title="Expand all"
            >
              <ChevronsUpDown size={14} />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={format}
            disabled={!canFormat}
            aria-label="Format"
            title={`Format — write the indentation into the file (${chordHint('s')} to save)`}
          >
            <IndentIncrease size={14} />
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
          title={`Save (${chordHint('s')})`}
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
        <>
          <JsonStrip fault={json.fault} shape={json.shape} size={size} onGoToFault={goToFault} />
          <div className="flex min-h-0 flex-1">
            {showPretty ? (
              <SourceEditor
                key={`${fileKey}:pretty`}
                path={path}
                initialContent={json.formatted ?? ''}
                editable={false}
                onChange={noop}
                onSave={() => void doc.save()}
                viewRef={viewRef}
                extensions={jsonFoldSummaries}
              />
            ) : (
              <SourceEditor
                key={`${fileKey}:raw`}
                path={path}
                initialContent={doc.content}
                editable={doc.editable}
                onChange={doc.setContent}
                onSave={() => void doc.save()}
                viewRef={viewRef}
                extensions={jsonFoldSummaries}
                onViewReady={revealIn}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** One quiet line under the header: what this document IS, or what stops it from
 *  being JSON. The fault is a state of the file rather than a failure of the app,
 *  so it takes the same amber as an unsaved dot — not the destructive red the save
 *  errors own. */
function JsonStrip({
  fault,
  shape,
  size,
  onGoToFault,
}: {
  fault: JsonFault | null
  shape: JsonShape | null
  size: string
  onGoToFault: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px]">
      {fault === null ? (
        <span className="min-w-0 truncate text-muted-foreground">
          {shape ? describeShape(shape) : ''}
        </span>
      ) : fault.kind === 'empty' ? (
        <span className="min-w-0 truncate text-muted-foreground">{fault.message}</span>
      ) : (
        <>
          <span className="min-w-0 truncate text-amber-500">{fault.message}</span>
          <button
            data-pressable
            type="button"
            onClick={onGoToFault}
            className="flex-none rounded px-1 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Line {fault.line}, column {fault.column}
          </button>
        </>
      )}
      <span className="ml-auto flex-none text-muted-foreground/60">{size}</span>
    </div>
  )
}

function ModeButton({
  active,
  disabled,
  onClick,
  title,
  label,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  title: string
  label: string
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-6 w-6 items-center justify-center rounded disabled:pointer-events-none disabled:opacity-40 ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function noop(): void {}
