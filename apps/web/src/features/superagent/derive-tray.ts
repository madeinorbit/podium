/**
 * Re-export shim: the tray's item model is platform-neutral and now lives in
 * @podium/client-core/viewmodels, so the phone tray derives from the SAME code
 * as the desktop column instead of a fork that drifted (POD-338).
 */
export {
  deriveTrayItems,
  offerKey,
  type TrayItem,
  trayCount,
  workingSessionCount,
} from '@podium/client-core/viewmodels'
