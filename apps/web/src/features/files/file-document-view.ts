import { RequestAnswer } from '@podium/client-graph/request-answer'
import { lazy } from '@podium/mobx-helpers'
import { action, observable, observableRef, runInAction } from 'mobx'
import type { FileScope } from '@podium/client-core/values'
import type { Trpc } from '@/app/trpc'
import { canSave } from './editor-save'

type ReadResult = Pick<
  Awaited<ReturnType<Trpc['files']['read']['query']>>,
  'ok' | 'content' | 'baseHash' | 'tooLarge' | 'binary' | 'error'
>
type WriteResult = Awaited<ReturnType<Trpc['files']['write']['mutate']>>
interface DocumentPorts {
  readFileScoped(scope: FileScope, path: string): Promise<ReadResult>
  writeFileScoped(input: {
    scope: FileScope
    path: string
    content: string
    baseHash?: string
  }): Promise<WriteResult>
}
interface Feedback {
  kind: 'success' | 'error'
  message: string
}
interface DocumentNotices {
  success(message: string): void
  error(
    message: string,
    options?: {
      action: { label: string; onClick(): Promise<void> }
      cancel: { label: string; onClick(): void }
    },
  ): void
}

/** One editable text buffer per opening. The read answer is consumed into the
 * buffer; disk hashes and save responses never escape this document owner. */
export class FileDocumentView extends RequestAnswer<ReadResult> {
  @observable accessor content = ''
  @observable accessor baseHash: string | undefined = undefined
  @observable accessor dirty = false
  @observable accessor saving = false
  @observableRef accessor saveFeedback: Feedback | null = null
  @observable accessor reloadNonce = 0
  @observable private accessor savedContent = ''
  private generation = 0
  constructor(
    readonly scope: FileScope,
    readonly path: string,
    private readonly ports: DocumentPorts,
    private readonly notices: DocumentNotices,
  ) {
    super()
  }
  @lazy get editable(): boolean {
    return this.scope.kind !== 'artifact'
  }
  @lazy get status(): 'loading' | 'ready' | 'error' {
    return this.loading || (this.answer === undefined && this.error === null)
      ? 'loading'
      : this.error || !this.answer?.ok
        ? 'error'
        : 'ready'
  }
  @lazy get message(): string {
    const r = this.answer
    return (
      this.error ??
      (!r?.ok
        ? r?.tooLarge
          ? 'File too large'
          : r?.binary
            ? 'Binary file'
            : (r?.error ?? 'Failed to open')
        : '')
    )
  }
  @lazy get reloadBlock(): string | undefined {
    return this.editable && (this.saving || this.content !== this.savedContent)
      ? `Save or discard your edits to "${this.path}" before reloading.`
      : undefined
  }
  @action setContent = (next: string): void => {
    this.content = next
    this.dirty = true
  }
  @action reload = (): void => {
    ++this.reloadNonce
    void this.open()
  }
  @action async open(): Promise<void> {
    ++this.generation
    this.dirty = false
    this.saving = false
    this.saveFeedback = null
    this.baseHash = undefined
    await this.load(
      () => this.ports.readFileScoped(this.scope, this.path),
      true,
      (answer) => {
        if (answer.ok) {
          this.content = answer.content ?? ''
          this.savedContent = this.content
          this.baseHash = answer.baseHash
        }
        return answer
      },
    )
  }
  @action save = async (overwrite = false): Promise<void> => {
    if (
      this.saving ||
      !canSave({ editable: this.editable, dirty: this.dirty, saving: this.saving })
    )
      return
    const generation = this.generation
    const body = this.content
    this.saving = true
    this.saveFeedback = null
    try {
      const result = await this.ports.writeFileScoped({
        scope: this.scope,
        path: this.path,
        content: body,
        ...(overwrite ? {} : { baseHash: this.baseHash }),
      })
      if (generation !== this.generation) return
      runInAction(() => {
        if (result.ok) {
          this.savedContent = body
          this.baseHash = result.baseHash
          this.dirty = this.content !== body
          this.saveFeedback = { kind: 'success', message: 'Saved' }
          this.notices.success(overwrite ? 'Saved (overwritten)' : 'Saved')
        } else if (result.conflict && !overwrite) {
          this.notices.error('File changed on disk — reload or overwrite', {
            action: {
              label: 'Overwrite',
              onClick: () => (generation === this.generation ? this.save(true) : Promise.resolve()),
            },
            cancel: {
              label: 'Reload',
              onClick: () => {
                if (generation === this.generation) this.reload()
              },
            },
          })
        } else {
          const message = result.error ?? 'Save failed'
          this.saveFeedback = { kind: 'error', message }
          this.notices.error(message)
        }
      })
    } catch (cause) {
      if (generation !== this.generation) return
      runInAction(() => {
        const message = cause instanceof Error ? cause.message : 'Save failed'
        this.saveFeedback = { kind: 'error', message }
        this.notices.error(message)
      })
    } finally {
      runInAction(() => {
        if (generation === this.generation) this.saving = false
      })
    }
  }
  @action override close(): void {
    ++this.generation
    super.close()
    this.content = ''
    this.savedContent = ''
    this.baseHash = undefined
    this.dirty = false
    this.saving = false
    this.saveFeedback = null
  }
}
