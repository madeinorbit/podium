// apps/web/src/SourceEditor.tsx
import type { EditorView as EditorViewType } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { type JSX, useEffect, useRef } from 'react'
import { langIdForPath, loadLanguage } from './editor-lang'

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
}: {
  path: string
  initialContent: string
  editable: boolean
  onChange: (next: string) => void
  onSave: () => void
  viewRef?: React.MutableRefObject<EditorViewType | null>
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const seedRef = useRef(initialContent)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

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
            ...ext,
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
    })()
    return () => {
      cancelled = true
      view?.destroy()
      if (viewRef) viewRef.current = null
    }
    // initialContent intentionally excluded: seed once per mount (keyed remount on reload).
  }, [path, editable, viewRef])

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-auto text-[13px]" />
}
