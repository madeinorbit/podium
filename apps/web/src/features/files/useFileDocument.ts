import { useStoreHandle } from '@podium/client-core/react'
import { type FileScope, scopeKey } from '@podium/client-core/values'
import { compareShallow, reaction } from 'mobx'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { Trpc } from '@/app/trpc'
import { registerReloadGuard } from '@/lib/reload-preparation'
import { FileDocumentView } from './file-document-view'

export type FileDocument = FileDocumentView

/** The unchanged provider proof includes a non-observer Document root, as do
 * existing editor roots. Keep this compatibility bridge only at this hook;
 * it invalidates their render without copying the answer into React state. */
function useDocumentChanges(view: FileDocumentView): void {
  const subscription = useMemo(() => {
    let revision = 0
    return {
      getSnapshot: () => revision,
      subscribe: (notify: () => void) =>
        reaction(
          () => [
            view.status,
            view.message,
            view.content,
            view.dirty,
            view.saving,
            view.saveFeedback,
            view.baseHash,
            view.reloadNonce,
          ],
          () => {
            revision++
            notify()
          },
          { equals: compareShallow, fireImmediately: true },
        ),
    }
  }, [view])
  useSyncExternalStore(subscription.subscribe, subscription.getSnapshot, subscription.getSnapshot)
}

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
  useDocumentChanges(view)
  return view
}
