import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { Save, X } from 'lucide-react'
import { type JSX, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { canSave } from './editor-save'
import { langIdForPath, loadLanguage } from './editor-lang'
import { useStore } from './store'

export function FileEditorPanel(): JSX.Element | null {
  const { editorFile, closeFile, readFile, writeFile } = useStore()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  // All files are opened editable; out-of-repo writes are rejected by the
  // daemon with an error which we surface via toast.
  const editable = true

  const save = useCallback(async () => {
    if (!editorFile || !viewRef.current) return
    if (!canSave({ editable, dirty, saving })) return
    setSaving(true)
    const content = viewRef.current.state.doc.toString()
    const r = await writeFile({ sessionId: editorFile.sessionId, path: editorFile.path, content, baseHash })
    setSaving(false)
    if (r.ok) {
      setBaseHash(r.baseHash)
      setDirty(false)
      toast.success('Saved')
    } else if (r.conflict) {
      toast.error('File changed on disk — reload or overwrite', {
        action: {
          label: 'Overwrite',
          onClick: async () => {
            setSaving(true)
            const r2 = await writeFile({ sessionId: editorFile.sessionId, path: editorFile.path, content })
            setSaving(false)
            if (r2.ok) {
              setBaseHash(r2.baseHash)
              setDirty(false)
              toast.success('Saved (overwritten)')
            } else {
              toast.error(r2.error ?? 'Save failed')
            }
          },
        },
        cancel: {
          label: 'Reload',
          onClick: () => setReloadNonce((n) => n + 1),
        },
      })
    } else {
      toast.error(r.error ?? 'Save failed')
    }
  }, [editorFile, writeFile, baseHash, dirty, saving, editable])

  // Keep a stable ref to save so the keydown handler doesn't go stale
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  useEffect(() => {
    if (!editorFile) return
    let cancelled = false
    setStatus('loading')
    setDirty(false)
    setBaseHash(undefined)
    void (async () => {
      const r = await readFile(editorFile.sessionId, editorFile.path)
      if (cancelled) return
      if (!r.ok) {
        setStatus('error')
        setMessage(r.tooLarge ? 'File too large' : r.binary ? 'Binary file' : (r.error ?? 'Failed to open'))
        return
      }
      setBaseHash(r.baseHash)
      const ext = await loadLanguage(langIdForPath(editorFile.path))
      if (cancelled || !hostRef.current) return

      const updateListener = EditorView.updateListener.of((u) => {
        if (u.docChanged) setDirty(true)
      })

      const keyHandler = EditorView.domEventHandlers({
        keydown(e) {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault()
            void saveRef.current()
          }
        },
      })

      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: r.content ?? '',
          extensions: [
            basicSetup,
            ...ext,
            EditorView.editable.of(editable),
            updateListener,
            keyHandler,
          ],
        }),
      })
      viewRef.current = view
      setStatus('ready')
    })()
    return () => {
      cancelled = true
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [editorFile, readFile, editable, reloadNonce])

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    closeFile()
  }, [dirty, closeFile])

  if (!editorFile) return null
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {editorFile.path}
          {dirty && <span className="ml-1 text-amber-500" aria-label="unsaved changes">●</span>}
        </span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave({ editable, dirty, saving })}
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
      {status === 'error' ? (
        <div className="p-4 text-sm text-muted-foreground">{message}</div>
      ) : (
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto text-[13px]" />
      )}
    </div>
  )
}
