/**
 * The write layer as the pool sees it (`WriteSeam`): the pending display the
 * pool's one reader lays over every row (`MobxPool.row`), and the edits a
 * model's setters make (`issue.title = x`, `MobxPool.edit`).
 *
 * The write arm creates it, passes it to the pool at construction and to the
 * write api (`createMobxWriteApi`), which mirrors the pending log into it
 * inside its actions and takes the model edits it forwards. The pool only
 * reads the display: every row it serves is the server row with this entry
 * laid over it, so models, row views, visibility and roll-ups see one value,
 * and no reader is replaced at runtime.
 *
 * One observable map entry per issue with a pending display: the newest
 * pending value per editable field (title, stage, readAt), never a row copy
 * (the pool's tables hold the borrowed server rows). Reading an absent key is
 * tracked too, so a node built before the first edit follows it.
 */

import { type ObservableMap, observable, observe } from 'mobx'
import { debugName } from '../debug-name'
import type { EntityName } from '../shared/schema'
import {
  type EditPatch,
  type TxId,
  type WritableKind,
  WriteContractError,
} from '../shared/write-contract'
import type { WriteSeam } from '../pool'

/** The editable fields of an issue row, as the overlay holds them. */
export type IssueOverlay = { title?: string; stage?: string; readAt?: string | null }

/** The write api's edit, as the overlay forwards a model's edit to it. */
export type Editor = <K extends WritableKind>(kind: K, id: string, patch: EditPatch<K>) => TxId

export class PendingOverlay implements WriteSeam {
  private readonly entries: ObservableMap<string, IssueOverlay> = observable.map<
    string,
    IssueOverlay
  >(undefined, { deep: false, name: debugName(() => 'write.overlays') })
  /** The write api that owns this overlay (`createMobxWriteApi` joins it), else null. */
  private editor: Editor | null = null

  /** Join the write api that mirrors its log here: model edits go through its `edit`. */
  join(editor: Editor): void {
    if (this.editor !== null) throw new WriteContractError('the write overlay already has a write api')
    this.editor = editor
  }

  /** The write api left (its dispose): model edits are refused again. */
  leave(): void {
    this.editor = null
  }

  /** A model's edit: one transaction of the joined write api's log. */
  edit<K extends WritableKind>(kind: K, id: string, patch: EditPatch<K>): TxId {
    if (this.editor === null) throw new WriteContractError('no write api owns this overlay')
    return this.editor(kind, id, patch)
  }

  /** TRACKED: the pending display of `entity:id`. Only issues carry editable fields. */
  pending(entity: EntityName, id: string): IssueOverlay | undefined {
    if (entity !== 'issue') return undefined
    return this.entries.get(id)
  }

  /** Let cold summary readers reuse their residency key for pending changes. */
  observePending(changed: (entity: EntityName, id: string) => void): () => void {
    return observe(this.entries, change => changed('issue', change.name))
  }

  /** Mirror the log's display for issue `id` (inside the write layer's action). */
  set(id: string, display: IssueOverlay): void {
    this.entries.set(id, display)
  }

  /** Drop issue `id`'s display; whether there was one (inside the write layer's action). */
  delete(id: string): boolean {
    if (!this.entries.has(id)) return false
    this.entries.delete(id)
    return true
  }

  /** Drop every display: the pool shows server truth again (the write layer's dispose). */
  clear(): void {
    this.entries.clear()
  }
}
