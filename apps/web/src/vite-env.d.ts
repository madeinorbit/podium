/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/info" />

interface ImportMetaEnv {
  readonly PODIUM_APP_VERSION?: string
  /**
   * True only under `bun run iterate` (scripts/iterate.ts): this bundle is
   * source served by a dev server in front of the installed backend, not the
   * dist the installed server serves. A `vite build` never sets it, so the
   * frame it gates is dead code in every shipped bundle.
   */
  readonly PODIUM_ITERATION_MODE?: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.css'
