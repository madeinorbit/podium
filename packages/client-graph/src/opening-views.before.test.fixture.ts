import { createIssuePageViews } from './issue-page'
import { createSettingsViews } from './settings-views'
import { createAutomationViews } from './automation-views'
import type { MobxPool } from './pool'

// Frozen pre-change ownership. The readers themselves are unchanged by this
// migration; compare both ownership paths on the very same pooled records.
export const beforeIssuePages = (pool: MobxPool) =>
  pool.sources.view('issue-page', () => createIssuePageViews(pool))
export const beforeSettingsView = (pool: MobxPool) =>
  pool.sources.view('settings.views', () => createSettingsViews(pool))
export const beforeAutomationViews = (pool: MobxPool) =>
  pool.sources.view('automations', () => createAutomationViews(pool))
