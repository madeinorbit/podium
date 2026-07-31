/**
 * POD-1223's suite, scoped away from a sibling that cannot be imported.
 *
 * `relay.browser.e2e.ts` imports `./harness`, which imports
 * `apps/server/src/local-machine` — a module that no longer exists on this
 * branch. Playwright resolves every file matching `testMatch` during COLLECTION,
 * before any CLI path filter applies, so that one broken import aborts the whole
 * run: `--project=chromium-desktop kernel-replica` never gets as far as loading
 * this issue's spec. POD-1227 filed it as POD-1234 while censusing the lane.
 *
 * It is not this issue's file and not this issue's regression, so this config
 * narrows `testMatch` instead of editing theirs. Everything else — testDir,
 * webServer, teardown, the desktop project — is inherited unchanged, so the suite
 * runs exactly as it will once it joins the normal lane.
 *
 * DELETE THIS FILE when POD-1234 lands. It is a workaround with an owner, not a
 * second lane: leaving a private config behind is how a suite quietly stops
 * running in the lane everyone else watches.
 */

import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: '**/kernel-replica.browser.e2e.ts',
})
