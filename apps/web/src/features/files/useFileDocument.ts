import { useStoreHandle } from '@podium/client-core/react'
import { type FileScope, scopeKey } from '@podium/client-core/values'
import { useObserver } from 'mobx-react-lite'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import type { Trpc } from '@/app/trpc'
import { registerReloadGuard } from '@/lib/reload-preparation'
import { FileDocumentView } from './file-document-view'

export type FileDocument = FileDocumentView

/** Bind one document owner to the opening; editors and previews read that
 * same buffer. The hook subscribes existing non-observer editor roots. */
export function useFileDocument(scope: FileScope, path: string): FileDocumentView {
  const { readFileScoped, writeFileScoped } = useStoreHandle<Trpc>().access
  const key = scopeKey(scope)
  // The scope key includes its machine/artifact identity; object churn is not a new opening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the canonical identity of scope.
  const view = useMemo(() => new FileDocumentView(scope, path, { readFileScoped, writeFileScoped }, toast), [key, path, readFileScoped, writeFileScoped])
  useEffect(() => { void view.open(); return () => view.close() }, [view])
  useEffect(() => registerReloadGuard(() => view.reloadBlock), [view])
  return useObserver(() => {
    void view.status; void view.message; void view.content; void view.dirty
    void view.saving; void view.saveFeedback; void view.baseHash; void view.reloadNonce
    return view
  })
}
