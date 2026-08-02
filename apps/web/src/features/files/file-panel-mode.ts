/**
 * Per-file panel-mode persistence — re-exported from the sole UI-state owner
 * (POD-329). Feature modules must not restate storage-key literals.
 */
export {
  FILE_MODE_MAP_CAP,
  type FilePanelMode,
  HTML_MODE_MAP_KEY,
  MD_MODE_MAP_KEY,
  readFilePanelMode,
  writeFilePanelMode,
} from '@podium/client-core/ui-state'