// apps/web/src/SourceEditor.tsx

import type { Extension } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import type { EditorView as EditorViewType } from '@codemirror/view'
import { basicSetup, EditorView } from 'codemirror'
import { type JSX, useEffect, useRef } from 'react'
import { langIdForPath, loadLanguage } from './editor-lang'
import { editorTheme } from './editor-theme'

/** CodeMirror source view over a document. Seeds from `initialContent` at mount;
 *  give it a stable `key` so a reload remounts with fresh content. Edits flow out
 *  via onChange — content is never pushed back in (avoids teardown while typing in
 *  split mode). */
export function SourceEditor({
  path,
  initialContent,
  editable,
  onChange,
  onSave,
  viewRef,
  extensions,
  onViewReady,
}: {
  path: string
  initialContent: string
  editable: boolean
  onChange: (next: string) => void
  onSave: () => void
  viewRef?: React.MutableRefObject<EditorViewType | null>
  /** Per-file-kind additions, appended last so they win. Must be stable across
   *  renders — a fresh array on every render would tear the editor down. */
  extensions?: Extension[]
  /** The view exists and is parented. The one hook for anything that has to wait
   *  for it — the language extension is loaded async, so `viewRef` is still null
   *  through the first paint. */
  onViewReady?: (view: EditorViewType) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const seedRef = useRef(initialContent)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onViewReadyRef = useRef(onViewReady)
  onViewReadyRef.current = onViewReady

  useEffect(() => {
    let cancelled = false
    let view: EditorView | null = null
    void (async () => {
      const ext = await loadLanguage(langIdForPath(path))
      if (cancelled || !hostRef.current) return
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: seedRef.current,
          extensions: [
            basicSetup,
            // AFTER basicSetup, so the shell's theme and highlighting win over
            // its stock light-background defaults.
            ...editorTheme,
            ...ext,
            ...(extensions ?? []),
            EditorView.editable.of(editable),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) onChangeRef.current(u.state.doc.toString())
            }),
            EditorView.domEventHandlers({
              keydown(e) {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  onSaveRef.current()
                }
              },
            }),
          ],
        }),
      })
      if (viewRef) viewRef.current = view
      onViewReadyRef.current?.(view)
    })()
    return () => {
      cancelled = true
      view?.destroy()
      if (viewRef) viewRef.current = null
    }
    // initialContent intentionally excluded: seed once per mount (keyed remount on reload).
  }, [path, editable, viewRef, extensions])

  // `overflow-hidden`, not `overflow-auto`: the editor owns a real height (see
  // `editorTheme`) and scrolls INSIDE itself, which is what keeps the line-number
  // gutter pinned while the document moves. Scrolling the host instead took the
  // gutter with it.
  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
}
