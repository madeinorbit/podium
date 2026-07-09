/**
 * Single-source the systemd daemon unit text (#245).
 *
 * The ONE authored copy of the daemon unit body is renderDaemonUnit() in
 * apps/cli/src/cli-systemd.ts — `podium setup` writes the real units through it at
 * runtime. install.sh's --join FALLBACK embeds a byte-copy in a heredoc (so a
 * curl|sh install still produces a unit when delegating to `podium setup --join`
 * fails); that copy is generated, never hand-edited:
 *
 *   bun scripts/render-systemd.ts           # regenerate the install.sh heredoc
 *   bun scripts/render-systemd.ts --check   # exit non-zero on drift (runs in `bun run lint`)
 *
 * The vitest lockstep test (apps/cli/src/cli-systemd.test.ts) enforces the same
 * byte-identity against the same single source.
 *
 * scripts/systemd/*.service are deliberately NOT rendered here: they are the
 * hand-authored dev-host units (run from SOURCE via `bun --conditions=@podium/source`
 * with host-specific WorkingDirectory/PATH), a different deployment from the packaged
 * `%h/.local/bin/podium daemon` unit that renderDaemonUnit produces.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderDaemonUnit } from '../apps/cli/src/cli-systemd'

const INSTALL_SH = fileURLToPath(new URL('../install.sh', import.meta.url))
// Same block the lockstep test pins: the fallback daemon-unit heredoc.
const HEREDOC = /(cat > "\$UNIT_DIR\/podium-daemon\.service" <<'EOF'\n)([\s\S]*?)(EOF\n)/

const check = process.argv.includes('--check')
const sh = readFileSync(INSTALL_SH, 'utf8')
const m = sh.match(HEREDOC)
if (!m) {
  console.error('render-systemd: install.sh no longer contains the fallback daemon-unit heredoc')
  process.exit(1)
}
const want = renderDaemonUnit()
if (m[2] === want) {
  console.log('render-systemd: install.sh fallback daemon unit matches renderDaemonUnit()')
  process.exit(0)
}
if (check) {
  console.error(
    'render-systemd: DRIFT — the install.sh fallback daemon unit differs from renderDaemonUnit() (apps/cli/src/cli-systemd.ts).\n' +
      'The render function is the single source; run `bun scripts/render-systemd.ts` to regenerate the heredoc.',
  )
  process.exit(1)
}
writeFileSync(
  INSTALL_SH,
  sh.replace(HEREDOC, (_all, open: string, _body: string, close: string) => open + want + close),
)
console.log('render-systemd: rewrote the install.sh fallback daemon unit from renderDaemonUnit()')
