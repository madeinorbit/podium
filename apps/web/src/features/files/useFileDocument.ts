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
  const [reloadNonce, setReloadNonce] = useState(0)
  const editable = true

  const setContent = useCallback((next: string) => {
    contentRef.current = next
    setContentState(next)
    setDirty(true)
  }, [])

  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])

  const save = useCallback(async () => {
    if (!canSave({ editable, dirty, saving })) return
    setSaving(true)
    const body = contentRef.current
    const r = await writeFileScoped({ scope: scopeRef.current, path, content: body, baseHash })
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
            const r2 = await writeFileScoped({
              scope: scopeRef.current,
              path,
              content: contentRef.current,
            })
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
        cancel: { label: 'Reload', onClick: reload },
      })
    } else {
      toast.error(r.error ?? 'Save failed')
    }
  }, [key, path, writeFileScoped, baseHash, dirty, saving, editable, reload])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setDirty(false)
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
    baseHash,
    reloadNonce,
    setContent,
    save,
    reload,
  }
}
