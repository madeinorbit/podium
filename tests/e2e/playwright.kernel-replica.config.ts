/** Focused runtime lane for the browser private-replica boot and interaction spec. */

import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: '**/kernel-replica.browser.e2e.ts',
})
