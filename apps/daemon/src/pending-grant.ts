/**
 * Daemon-local compatibility path for the shared pending-update marker.
 *
 * The parent owns the all-in-one health gate, so the marker implementation is
 * shared with the runtime package while daemon call sites keep their local API.
 */
export {
  clearPendingGrant,
  finalizePendingGrant,
  readPendingGrant,
  writePendingGrant,
} from '@podium/runtime/update-pending'
export type { PendingGrant, WriteMarkerBytes } from '@podium/runtime/update-pending'
