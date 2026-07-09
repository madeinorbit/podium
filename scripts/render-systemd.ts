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
// Same block the lockstep test pins: the fallback daemon-unit heredoc. Extraction
// is LINE-based and refuses anything ambiguous: exactly one opener line; the body
// runs to the first line that is EXACTLY `EOF`; if the scan crosses another
// heredoc opener first (which happens when the daemon block's closer was removed
// or malformed to e.g. `EOF ` / `EOF\r`), we refuse rather than let a
// regeneration swallow unrelated installer logic between two heredocs.
const OPENER = `cat > "$UNIT_DIR/podium-daemon.service" <<'EOF'`

const check = process.argv.includes('--check')
const sh = readFileSync(INSTALL_SH, 'utf8')
const lines = sh.split('\n')
const openerIdxs = lines.flatMap((l, i) => (l.trim() === OPENER ? [i] : []))
if (openerIdxs.length !== 1 || openerIdxs[0] === undefined) {
  console.error(
    `render-systemd: refusing — install.sh contains ${openerIdxs.length} daemon-unit heredoc opener lines, expected exactly one`,
  )
  process.exit(1)
}
const openerIdx = openerIdxs[0]
let closeIdx = -1
for (let i = openerIdx + 1; i < lines.length; i++) {
  const line = lines[i]
  if (line === 'EOF') {
    closeIdx = i
    break
  }
  if (line?.includes("<<'EOF'")) {
    console.error(
      `render-systemd: refusing — scan crossed another heredoc opener at install.sh line ${i + 1} before finding the daemon block's EOF closer (malformed/removed delimiter?)`,
    )
    process.exit(1)
  }
}
if (closeIdx === -1) {
  console.error(
    'render-systemd: refusing — no EOF closer line found for the daemon-unit heredoc in install.sh',
  )
  process.exit(1)
}
const body = `${lines.slice(openerIdx + 1, closeIdx).join('\n')}\n`
const want = renderDaemonUnit()
if (body === want) {
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
  [...lines.slice(0, openerIdx + 1), want.replace(/\n$/, ''), ...lines.slice(closeIdx)].join('\n'),
)
console.log('render-systemd: rewrote the install.sh fallback daemon unit from renderDaemonUnit()')
