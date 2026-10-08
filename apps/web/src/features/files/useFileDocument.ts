import { useStoreHandle } from '@podium/client-core/react'
import { type FileScope, scopeKey } from '@podium/client-core/values'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import type { Trpc } from '@/app/trpc'
import { registerReloadGuard } from '@/lib/reload-preparation'
import { useViewFields } from '@/lib/use-view-fields'
import { FileDocumentView } from './file-document-view'

export type FileDocument = FileDocumentView

const documentFields = (view: FileDocumentView) => [
  view.status,
  view.message,
  view.content,
  view.dirty,
  view.saving,
  view.saveFeedback,
  view.baseHash,
  view.reloadNonce,
]

/** Bind one document owner to the opening; editors and previews read that
 * same buffer. The hook subscribes existing non-observer editor roots. */
export function useFileDocument(scope: FileScope, path: string): FileDocumentView {
  const { readFileScoped, writeFileScoped } = useStoreHandle<Trpc>().access
  const key = scopeKey(scope)
  // The scope key includes its machine/artifact identity; object churn is not a new opening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the canonical identity of scope.
  const view = useMemo(
    () => new FileDocumentView(scope, path, { readFileScoped, writeFileScoped }, toast),
    [key, path, readFileScoped, writeFileScoped],
  )
  useEffect(() => {
    void view.open()
    return () => view.close()
  }, [view])
  useEffect(() => registerReloadGuard(() => view.reloadBlock), [view])
  useViewFields(view, documentFields)
  return view
}
