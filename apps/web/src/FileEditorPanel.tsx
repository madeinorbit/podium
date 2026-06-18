import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { langIdForPath, loadLanguage } from './editor-lang'
import { useStore } from './store'

export function FileEditorPanel(): JSX.Element | null {
  const { editorFile, closeFile, readFile } = useStore()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!editorFile) return
    let view: EditorView | null = null
    let cancelled = false
    setStatus('loading')
    void (async () => {
      const r = await readFile(editorFile.sessionId, editorFile.path)
      if (cancelled) return
      if (!r.ok) {
        setStatus('error')
        setMessage(r.tooLarge ? 'File too large' : r.binary ? 'Binary file' : (r.error ?? 'Failed to open'))
        return
      }
      const ext = await loadLanguage(langIdForPath(editorFile.path))
      if (cancelled || !hostRef.current) return
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: r.content ?? '',
          extensions: [basicSetup, ...ext, EditorView.editable.of(false)],
        }),
      })
      setStatus('ready')
    })()
    return () => {
      cancelled = true
      view?.destroy()
    }
  }, [editorFile, readFile])

  if (!editorFile) return null
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {editorFile.path}
        </span>
        <button type="button" onClick={closeFile} aria-label="Close" className="text-muted-foreground">
          <X size={16} />
        </button>
      </div>
      {status === 'error' ? (
        <div className="p-4 text-sm text-muted-foreground">{message}</div>
      ) : (
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto text-[13px]" />
      )}
    </div>
  )
}
