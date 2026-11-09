import { lazy } from '@podium/mobx-helpers'
import { asIssueId, asSessionId, asThreadId } from '@podium/model'
import { action, reaction } from 'mobx'
import type { VisibilitySource } from '../engine/visibility'
import type { UiState } from '../replica/contract'
import {
  type FileScrollPosition,
  readStoredDockShells,
  readStoredFileTabs,
  readStoredRecentFiles,
  readStoredView,
  UI_STATE_KEYS,
  uiStateRoute,
} from '../ui-state'
import { allTabIds, deserializeWorkspaces, emptyWorkspace, openTab, splitPane } from '../values'
import type { DeviceStorage } from './device-storage'
import { DEVICE_DRAFT_KEYS, type LegacyDeviceKeys } from './draft-storage'
import type { UiStore } from './ui-store'

/** Only these device-local screen keys are imported. Synced preferences never are. */
export const MIGRATED_SCREEN_KEYS = [
  'view',
  'selectedWorktree',
  'selectedIssueId',
  'workspaces',
  'fileTabs',
  'fileScroll',
  'dockShells',
  'recentFiles',
  'paneA',
  'paneB',
  'split',
] as const
const nullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const stringify = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

export class UiPersistence {
  readonly key: string
  private stop: (() => void) | undefined
  private offVisibility: (() => void) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private erased = false
  private dirty = false
  constructor(
    private readonly ui: UiStore,
    private readonly device: DeviceStorage,
    private readonly legacy: LegacyDeviceKeys,
    private readonly visibility: VisibilitySource,
  ) {
    this.key = `${device.keyPrefix}.ui.v1`
    this.load()
  }
  @lazy get snapshot() {
    const ui = this.ui
    return {
      version: 1,
      view: ui.view,
      selectedWorktree: ui.selectedWorktree,
      selectedIssueId: ui.selectedIssueId,
      settingsTab: ui.settingsTab,
      openIssueId: ui.openIssueId,
      superThreadId: ui.superThreadId,
      attachedSessionId: ui.attachedSessionId,
      dockVisibleSession: ui.dockVisibleSession,
      focusedPane: ui.focusedPane,
      workspaces: ui.workspaces,
      dockShells: ui.dockShells,
      recentFiles: ui.recentFiles,
      devicePrefs: Object.fromEntries(ui.devicePrefs),
      fileTabs: [...ui.fileTabs.values()],
      fileScroll: Object.fromEntries(ui.fileScroll),
    }
  }
  @action private load(): void {
    let raw: string | null = null
    try {
      raw = this.device.storage.getItem(this.key)
    } catch {}
    if (raw !== null) {
      try {
        const saved = record(JSON.parse(raw))
        if (saved.version === 1) this.restore(saved)
      } catch {
        /* A malformed document is the defaults, without importing old state. */
      }
      return
    }
    const old = this.legacy
    this.restore({
      version: 1,
      view: readStoredView(old),
      selectedWorktree: old.get(UI_STATE_KEYS.selectedWorktree),
      selectedIssueId: old.get(UI_STATE_KEYS.selectedIssueId),
      workspaces: deserializeWorkspaces(old.get(UI_STATE_KEYS.workspaces)),
      fileTabs: readStoredFileTabs(old),
      dockShells: readStoredDockShells(old),
      recentFiles: readStoredRecentFiles(old),
      fileScroll: parse(old.get(UI_STATE_KEYS.fileScroll)),
    })
    // Pre-workspace installs kept two pane scalars. Fold them into a real tree once.
    if (!Object.keys(this.ui.workspaces).length) {
      const paneA = old.get(UI_STATE_KEYS.paneA),
        paneB = old.get(UI_STATE_KEYS.paneB)
      if (paneA || paneB) {
        const key = this.ui.selectedIssueId
          ? (`issue:${this.ui.selectedIssueId}` as const)
          : this.ui.selectedWorktree
            ? (`wt:${this.ui.selectedWorktree}` as const)
            : 'none'
        let ws = emptyWorkspace(key)
        if (paneA) ws = openTab(ws, paneA, { permanent: true })
        if (old.get(UI_STATE_KEYS.split) === '1') {
          ws = splitPane(ws, ws.focusedPaneId, 'row', paneB ? { tabId: paneB } : undefined)
        }
        this.ui.patch({ workspaces: { [key]: ws } })
      }
    }
    const screenKeys = new Set(MIGRATED_SCREEN_KEYS.map((field) => UI_STATE_KEYS[field]))
    const prefKeys: string[] = []
    for (const key of old.keys()) {
      if (screenKeys.has(key as never) || DEVICE_DRAFT_KEYS.has(key)) continue
      try {
        if (uiStateRoute(key).home === 'device-local') {
          const value = old.get(key)
          if (value !== null) {
            this.ui.setDevicePref(key, value)
            prefKeys.push(key)
          }
        }
      } catch {
        /* No unrelated or undeclared key is imported. */
      }
    }
    try {
      this.device.storage.setItem(this.key, JSON.stringify(this.snapshot))
      for (const field of MIGRATED_SCREEN_KEYS) old.set(UI_STATE_KEYS[field], null)
      for (const key of prefKeys) old.set(key, null)
    } catch {
      /* Keep the old keys until the new document can be saved. */
    }
  }
  @action private restore(saved: Record<string, unknown>): void {
    const get = {
      get: (key: string) => {
        const field = Object.entries(UI_STATE_KEYS).find(([, value]) => value === key)?.[0]
        return field ? stringify(saved[field]) : null
      },
    }
    const ui = this.ui
    ui.patch({
      view: readStoredView({ get: () => (typeof saved.view === 'string' ? saved.view : null) }),
      selectedWorktree: nullableString(saved.selectedWorktree),
      selectedIssueId: saved.selectedIssueId
        ? asIssueId(nullableString(saved.selectedIssueId) ?? '') || null
        : null,
      settingsTab: nullableString(saved.settingsTab),
      openIssueId: nullableString(saved.openIssueId)
        ? asIssueId(saved.openIssueId as string)
        : null,
      superThreadId:
        saved.superThreadId === null
          ? null
          : asThreadId(nullableString(saved.superThreadId) ?? 'global'),
      attachedSessionId: nullableString(saved.attachedSessionId)
        ? asSessionId(saved.attachedSessionId as string)
        : null,
      dockVisibleSession: nullableString(saved.dockVisibleSession),
      focusedPane: nullableString(saved.focusedPane) ?? 'p0',
      workspaces: deserializeWorkspaces(stringify(saved.workspaces)),
      dockShells: readStoredDockShells(get),
      fileTabs: readStoredFileTabs(get),
      recentFiles: readStoredRecentFiles(get),
    })
    for (const [key, value] of Object.entries(record(saved.devicePrefs))) {
      if (typeof value !== 'string' || DEVICE_DRAFT_KEYS.has(key)) continue
      try {
        if (uiStateRoute(key).home === 'device-local') ui.setDevicePref(key, value)
      } catch {}
    }
    for (const [id, value] of Object.entries(record(saved.fileScroll))) {
      const position = typeof value === 'number' ? { top: value, left: 0 } : record(value)
      if (
        typeof position.top === 'number' &&
        Number.isFinite(position.top) &&
        position.top >= 0 &&
        typeof position.left === 'number' &&
        Number.isFinite(position.left) &&
        position.left >= 0
      )
        ui.setFileScroll(id, position as unknown as FileScrollPosition)
    }
  }
  start(): void {
    if (this.stop || this.erased) return
    this.dirty = true
    this.stop = reaction(
      () => this.snapshot,
      () => {
        this.dirty = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.flush().catch(() => {})
        }, 300)
      },
    )
    this.offVisibility = this.visibility.subscribe(() => {
      if (!this.visibility.isVisible()) void this.flush().catch(() => {})
    })
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
      window.addEventListener('pagehide', this.onHide)
  }
  private readonly onHide = () => {
    void this.flush().catch(() => {})
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.erased) return
    if (this.dirty) {
      this.device.storage.setItem(this.key, JSON.stringify(this.snapshot))
      this.dirty = false
    }
    await this.device.flush?.()
  }
  stopSaving(): void {
    this.stop?.()
    this.stop = undefined
    this.offVisibility?.()
    this.offVisibility = undefined
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function')
      window.removeEventListener('pagehide', this.onHide)
    void this.flush().catch(() => {})
  }
  erase(): void {
    this.stopSaving()
    this.erased = true
    this.device.storage.removeItem(this.key)
  }
}
function parse(value: string | null): unknown {
  try {
    return JSON.parse(value ?? '{}')
  } catch {
    return {}
  }
}
