/**
 * Codex install layout — the Inventory install section (POD-4414 §4.4).
 *
 * KNOWLEDGE, not mechanism: the vendor installer URL, the shell it runs
 * under, and the env it needs. The temp-dir lifecycle, the fetch, and the
 * `--version` verification around it are the generic mechanism
 * (`inventory/install.ts`) and stay harness-free.
 */
import type { HarnessInstall } from '../../manifest.js'

export const codexInstall: HarnessInstall = {
  binary: 'codex',
  url: (env) => env.PODIUM_CODEX_INSTALL_URL ?? 'https://chatgpt.com/codex/install.sh',
  runInstaller(scriptPath, binDir, ports) {
    // Codex exits non-zero without CODEX_NON_INTERACTIVE, and installs to the
    // wrong directory without CODEX_INSTALL_DIR — getting these wrong is silent.
    ports.run('sh', [scriptPath], {
      ...ports.env,
      CODEX_NON_INTERACTIVE: '1',
      CODEX_INSTALL_DIR: binDir,
    })
  },
}
