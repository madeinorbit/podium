import { applySettingsPatch, changedSettingsLeaves } from '@podium/commands/settings-write-plan'
import { SETTINGS_PATH_TIERS } from '@podium/model/browser'
import { draft, lazy } from '@podium/mobx-helpers'
import type { PodiumSettings } from '@podium/runtime'
import { action, runInAction } from 'mobx'
import type { SaveSettingsResult } from './save-settings'

type Branch = Record<string, unknown>
interface Node {
  value: Branch
  dirty(): boolean
  reset(): void
  patch(patch: Branch): void
  collect(prefix: string, changes: Branch): void
  clearSaved(prefix: string, sent: Branch, refused: Set<string>): void
}

/** Nested settings groups are replaced by the server. Their leaf sources read
 * through the shared record on every access, rather than retaining a group. */
function node(read: () => Branch, paths: readonly string[]): Node {
  const keys = [...new Set(paths.map(path => path.split('.')[0]!))]
  const leaves = keys.filter(key => paths.includes(key))
  const source: Branch = {}
  for (const key of leaves) Object.defineProperty(source, key, { enumerable: true, get: () => read()[key] })
  const edits = draft(source, { fields: leaves, save: changes => changes })
  const children = keys.filter(key => !leaves.includes(key)).map(key => ({ key,
    node: node(() => read()[key] as Branch, paths.filter(path => path.startsWith(`${key}.`)).map(path => path.slice(key.length + 1))),
  }))
  const value: Branch = {}
  for (const key of leaves) Object.defineProperty(value, key, { enumerable: true, get: () => edits[key] })
  for (const child of children) Object.defineProperty(value, child.key, { enumerable: true, get: () => child.node.value })
  return {
    value,
    dirty: () => edits.isDirty || children.some(child => child.node.dirty()),
    reset() { edits.reset(); for (const child of children) child.node.reset() },
    patch(patch) {
      for (const key of leaves) if (Object.hasOwn(patch, key)) edits[key] = patch[key]
      for (const child of children) if (Object.hasOwn(patch, child.key)) child.node.patch(patch[child.key] as Branch)
    },
    collect(prefix, changes) {
      for (const [key, value] of edits.changedValues) changes[`${prefix}${key}`] = value
      for (const child of children) child.node.collect(`${prefix}${child.key}.`, changes)
    },
    clearSaved(prefix, sent, refused) {
      for (const [key, value] of edits.changedValues) {
        const path = `${prefix}${key}`
        if (!refused.has(path) && Object.hasOwn(sent, path) && Object.is(value, sent[path])) edits.resetProperty(key)
      }
      for (const child of children) child.node.clearSaved(`${prefix}${child.key}.`, sent, refused)
    },
  }
}

/** A form view model composed of standard drafts at the command's leaf fields.
 * Sections keep their existing settings shape; it contains live getters only. */
export class SettingsEditDraft {
  private readonly tree: Node
  readonly settings: PodiumSettings
  private readonly submission
  constructor(readonly record: PodiumSettings, save: (previous: PodiumSettings, next: PodiumSettings) => Promise<SaveSettingsResult>) {
    this.tree = node(() => record as unknown as Branch, SETTINGS_PATH_TIERS.map(field => field.path))
    this.settings = this.tree.value as PodiumSettings
    // The root draft submits one command plan; leaf drafts own the touched fields.
    this.submission = draft(record, { fields: [...new Set(SETTINGS_PATH_TIERS.map(field => field.path.split('.')[0]!))] as (keyof PodiumSettings & string)[], save: async () => {
      const sent: Branch = {}
      this.tree.collect('', sent)
      const previous = Object.fromEntries(Object.keys(this.settings).map(key => [key, record[key as keyof PodiumSettings]])) as PodiumSettings
      const result = await save(previous, applySettingsPatch(previous, sent))
      runInAction(() => this.tree.clearSaved('', sent, new Set(result.refusals.map(refusal => refusal.path))))
      return result
    } })
  }
  @lazy get isDirty() { return this.tree.dirty() }
  @action patch(patch: Partial<PodiumSettings>): void {
    // Section controls spread a group; only changed leaves become local edits.
    const next = { ...this.settings, ...patch }
    const changed = changedSettingsLeaves(this.settings, next)
    this.tree.patch(applySettingsPatch({}, Object.fromEntries(changed.map(field => [field.path, field.value]))))
  }
  @action reset(): void { this.tree.reset(); this.submission.reset() }
  @action submit() {
    if (!this.isDirty) return undefined
    const sent: Branch = {}
    this.tree.collect('', sent)
    for (const path of Object.keys(sent)) {
      const key = path.split('.')[0] as keyof PodiumSettings
      this.submission[key] = this.settings[key] as never
    }
    return this.submission.submit()
  }
}
