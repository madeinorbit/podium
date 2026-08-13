/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/info" />

interface ImportMetaEnv {
  readonly PODIUM_APP_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.css'
