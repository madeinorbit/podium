import { shallowEqual } from '@podium/client-core/store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useStoreSelector } from '@/app/store'
import { type FileScope, scopeKey } from '@/lib/file-scope'
import { canSave } from './editor-save'

export interface FileDocument {
  status: 'loading' | 'ready' | 'error'
  message: string
  content: string
  contentRef: React.MutableRefObject<string>
  editable: boolean
  dirty: boolean
  saving: boolean
  saveFeedback: { kind: 'success' | 'error'; message: string } | null
  baseHash: string | undefined
  reloadNonce: number
  setContent: (next: string) => void
  save: () => Promise<void>
  reload: () => void
}

/** Owns one open file's content + save lifecycle, decoupled from any editor view
 *  so a preview and a source editor can share the same document. Extracted from
 *  the original FileEditorPanel. All files open editable; the daemon rejects
 *  out-of-repo writes, surfaced via toast. */
export function useFileDocument(scope: FileScope, path: string): FileDocument {
  const { readFileScoped, writeFileScoped } = useStoreSelector(
    (s) => ({ readFileScoped: s.readFileScoped, writeFileScoped: s.writeFileScoped }),
    shallowEqual,
  )
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const key = scopeKey(scope)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [content, setContentState] = useState('')
  const contentRef = useRef('')
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveFeedback, setSaveFeedback] = useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // Artifact snapshots are immutable ([spec:SP-0fc9] #441) — no save path.
  const editable = scope.kind !== 'artifact'

  const setContent = useCallback((next: string) => {
    contentRef.current = next
    setContentState(next)
    setDirty(true)
  }, [])

  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])

  const save = useCallback(async () => {
    if (savingRef.current || !canSave({ editable, dirty, saving })) return
    savingRef.current = true
    setSaving(true)
    setSaveFeedback(null)
    const body = contentRef.current
    let r: Awaited<ReturnType<typeof writeFileScoped>>
    try {
      r = await writeFileScoped({ scope: scopeRef.current, path, content: body, baseHash })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Save failed'
      setSaveFeedback({ kind: 'error', message })
      toast.error(message)
      savingRef.current = false
      setSaving(false)
      return
    }
    savingRef.current = false
    setSaving(false)
    if (r.ok) {
      setBaseHash(r.baseHash)
      setDirty(false)
      setSaveFeedback({ kind: 'success', message: 'Saved' })
      toast.success('Saved')
    } else if (r.conflict) {
      toast.error('File changed on disk — reload or overwrite', {
        action: {
          label: 'Overwrite',
          onClick: async () => {
            if (savingRef.current) return
            savingRef.current = true
            setSaving(true)
            try {
              const r2 = await writeFileScoped({
                scope: scopeRef.current,
                path,
                content: contentRef.current,
              })
              if (r2.ok) {
                setBaseHash(r2.baseHash)
                setDirty(false)
                setSaveFeedback({ kind: 'success', message: 'Saved' })
                toast.success('Saved (overwritten)')
              } else {
                const message = r2.error ?? 'Save failed'
                setSaveFeedback({ kind: 'error', message })
                toast.error(message)
              }
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : 'Save failed'
              setSaveFeedback({ kind: 'error', message })
              toast.error(message)
            } finally {
              savingRef.current = false
              setSaving(false)
            }
          },
        },
        cancel: { label: 'Reload', onClick: reload },
      })
    } else {
      const message = r.error ?? 'Save failed'
      setSaveFeedback({ kind: 'error', message })
      toast.error(message)
    }
  }, [key, path, writeFileScoped, baseHash, dirty, saving, editable, reload])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setDirty(false)
    setSaveFeedback(null)
    setBaseHash(undefined)
    void (async () => {
      const r = await readFileScoped(scopeRef.current, path)
      if (cancelled) return
      if (!r.ok) {
        setStatus('error')
        setMessage(
          r.tooLarge ? 'File too large' : r.binary ? 'Binary file' : (r.error ?? 'Failed to open'),
        )
        return
      }
      contentRef.current = r.content ?? ''
      setContentState(r.content ?? '')
      setBaseHash(r.baseHash)
      setStatus('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [key, path, readFileScoped, reloadNonce])

  return {
    status,
    message,
    content,
    contentRef,
    editable,
    dirty,
    saving,
    saveFeedback,
    baseHash,
    reloadNonce,
    setContent,
    save,
    reload,
  }
}
