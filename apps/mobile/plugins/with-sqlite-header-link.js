const { withPodfile } = require('expo/config-plugins')

/**
 * RESTORE ExpoSQLite's PUBLIC sqlite3.h LINK AT POD INSTALL TIME.
 *
 * `expo-sqlite`'s Swift half reads the vendored, symbol-prefixed header
 * (`exsqlite3_*`) through its umbrella's quoted `#import "sqlite3.h"`, and
 * `-import-underlying-module` resolves a quoted import STRICTLY inside the
 * module's own public header directory. The podspec vendors `ios/sqlite3.{c,h}`
 * while the spec is evaluated, so a `pod install` that runs before those files
 * exist (a fresh `node_modules`, a cold clone, CI) writes
 * `Pods/Headers/Public/ExpoSQLite` WITHOUT the `sqlite3.h` link — and the next
 * clean build fails with `cannot find 'exsqlite3_open' in scope` on every
 * symbol, in a file nobody here wrote.
 *
 * It cost an afternoon in 2026-08 because the failure survives everything that
 * usually clears it: reinstalling pods, `pod update`, a pristine `bun install`,
 * and wiping DerivedData — the poisoned clang module also lives in the SHARED
 * `~/Library/Developer/Xcode/ModuleCache.noindex`. The link is the fix, so it
 * belongs in the generated Podfile rather than in one machine's memory:
 * `apps/mobile/ios` is gitignored, and a hand-edited Podfile is one
 * `expo prebuild --clean` away from gone.
 */

const MARKER = '# @podium sqlite-header-link'

const HOOK = `${MARKER}
    # ExpoSQLite's umbrella imports "sqlite3.h" by quote, which Swift resolves
    # only inside the pod's public header dir. A pod install that ran before the
    # podspec vendored ios/sqlite3.h leaves that link out, and every exsqlite3_*
    # symbol goes missing on the next clean build. Put it back — no-op when the
    # link is already there. See plugins/with-sqlite-header-link.js.
    sqlite_public = File.join(installer.sandbox.root, 'Headers', 'Public', 'ExpoSQLite')
    sqlite_header = begin
      pkg = \`node --print "require.resolve('expo-sqlite/package.json')"\`.strip
      pkg.empty? ? nil : File.join(File.dirname(pkg), 'ios', 'sqlite3.h')
    rescue StandardError
      nil
    end
    if sqlite_header && File.exist?(sqlite_header) && File.directory?(sqlite_public) &&
       !File.exist?(File.join(sqlite_public, 'sqlite3.h'))
      FileUtils.ln_s(sqlite_header, File.join(sqlite_public, 'sqlite3.h'))
      Pod::UI.puts '[podium] restored Headers/Public/ExpoSQLite/sqlite3.h'
    end
`

const ANCHOR = /^[ \t]*post_install do \|installer\|[ \t]*\n/m

/**
 * Puts the hook at the top of the Podfile's `post_install` block, once. Running
 * prebuild over an existing `ios/` directory re-runs this against a Podfile that
 * already carries the hook, so the marker is what keeps it from stacking.
 *
 * A missing anchor throws rather than passing the Podfile through: a silent
 * no-op here hands back the exact build failure this plugin exists to prevent.
 */
function addSqliteHeaderLink(podfile) {
  if (podfile.includes(MARKER)) return podfile
  const anchor = podfile.match(ANCHOR)
  if (!anchor) {
    throw new Error(
      'with-sqlite-header-link: no `post_install do |installer|` block in the Podfile — ' +
        'the template changed, so the ExpoSQLite header link needs a new anchor.',
    )
  }
  const at = anchor.index + anchor[0].length
  return `${podfile.slice(0, at)}    ${HOOK}${podfile.slice(at)}`
}

const withSqliteHeaderLink = (config) =>
  withPodfile(config, (config) => {
    config.modResults.contents = addSqliteHeaderLink(config.modResults.contents)
    return config
  })

module.exports = withSqliteHeaderLink
module.exports.addSqliteHeaderLink = addSqliteHeaderLink
