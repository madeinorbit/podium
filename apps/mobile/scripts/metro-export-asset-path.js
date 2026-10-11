const baseUrl = require('../app.json').expo.experiments?.baseUrl ?? ''

// Metro builds httpServerLocation from the resolved source path. With Bun's
// global store that leaks cache directories and store keys into the export,
// making staged Windows resources exceed NSIS's MAX_PATH limit. Change asset
// metadata before BOTH Expo's transformer and exporter consume it: moving files
// after export would leave the JavaScript URLs pointing at their old locations.
// Metro's hash covers the whole scale group; source files and filenames stay intact.
module.exports = function exportAssetPath(asset) {
  if (!asset.httpServerLocation.includes('?export_path=')) return asset
  return {
    ...asset,
    httpServerLocation: `/assets?export_path=${baseUrl}/assets/${asset.hash}`,
  }
}
