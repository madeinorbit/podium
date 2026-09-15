/**
 * Re-export shim (P2c): the 1049 screen-mode tracker is pure output
 * interpretation, so its canonical home is `@podium/process/screen`.
 * This module re-exports it so existing daemon importers keep working.
 */
export { type ScreenMode, ScreenModeTracker } from '@podium/process/screen'
