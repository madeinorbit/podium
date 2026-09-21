/**
 * Grok install layout — the Inventory install section (POD-4414 §4.4).
 *
 * KNOWLEDGE, not mechanism: the vendor installer URL, the shell it runs
 * under, and the env it needs. The temp-dir lifecycle, the fetch, and the
 * `--version` verification around it are the generic mechanism
 * (`inventory/install.ts`) and stay harness-free.
 */
import type { HarnessInstall } from '../../manifest.js'

export const grokInstall: HarnessInstall = {
  binary: 'grok',
  url: (env) => env.PODIUM_GROK_INSTALL_URL ?? 'https://x.ai/cli/install.sh',
  runInstaller(scriptPath, binDir, ports) {
    // Without GROK_BIN_DIR the vendor script installs to the wrong directory.
    ports.run('bash', [scriptPath], { ...ports.env, GROK_BIN_DIR: binDir })
  },
}
