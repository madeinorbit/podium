import { reaction } from 'mobx'
import type { Router, RouteState } from '../ui-state'
import type { UiStore } from './ui-store'

/** The one owner of URL ↔ screen reactions. Links/popstate enter; selection exits. */
export class UrlMirror {
  private stop: (() => void) | undefined
  private offRoute: (() => void) | undefined
  private applying = false
  constructor(
    private readonly ui: UiStore,
    private readonly router: Router,
    private readonly adopt: (route: RouteState) => void,
  ) {}
  start(): void {
    if (this.stop) return
    this.router.attach()
    this.offRoute = this.router.subscribe((route) => {
      if (this.applying) return
      this.applying = true
      try {
        this.adopt(route)
      } finally {
        this.applying = false
      }
    })
    this.stop = reaction(
      () =>
        [
          this.ui.view,
          this.ui.settingsTab,
          this.ui.openIssueId,
          this.ui.selectedWorktree,
          this.ui.paneA,
        ] as const,
      () => this.mirror(),
    )
    this.mirror()
  }
  mirror(): void {
    if (this.applying) return
    const ui = this.ui,
      current = this.router.current()
    this.applying = true
    try {
      this.router.replace({
        ...current,
        view: ui.view,
        settingsTab: ui.settingsTab,
        issueId: ui.openIssueId,
        worktree: ui.selectedWorktree,
        pane: ui.paneA,
      })
    } finally {
      this.applying = false
    }
  }
  stopMirroring(): void {
    this.stop?.()
    this.stop = undefined
    this.offRoute?.()
    this.offRoute = undefined
    this.router.dispose()
  }
}
