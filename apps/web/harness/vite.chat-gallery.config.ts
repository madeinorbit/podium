import { fileURLToPath } from 'node:url'
import {
  type ConfigEnv,
  defineConfig,
  mergeConfig,
  type UserConfig,
  type ViteDevServer,
} from 'vite'
import harness from '../vite.harness.config'

const stub = fileURLToPath(new URL('./chat-gallery-pool-stub.ts', import.meta.url))
export default defineConfig(async (env) =>
  mergeConfig(await (harness as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    plugins: [
      {
        name: 'chat-gallery-layout-pool',
        enforce: 'pre',
        resolveId: (source: string) =>
          source.replace(/\.tsx?$/, '').endsWith('/src/app/store-worklist-pool') ? stub : null,
        configureServer(server: ViteDevServer) {
          // Self-contained default references; a capture can substitute the
          // operator's images without committing private screenshot assets.
          server.middlewares.use('/files/asset', (request, response) => {
            const path =
              new URL(request.url ?? '/', 'http://harness').searchParams.get('path') ?? ''
            const title = path.includes('claude')
              ? 'Claude Code'
              : path.includes('codex')
                ? 'Codex'
                : 'Podium'
            response.setHeader('Content-Type', 'image/svg+xml')
            response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
              <rect width="480" height="360" rx="10" fill="#fff"/>
              <rect x="1" y="1" width="478" height="358" rx="10" fill="none" stroke="#e2e0d9"/>
              <rect x="16" y="16" width="448" height="36" rx="5" fill="#f4f3f0"/>
              <text x="28" y="40" font-family="sans-serif" font-size="16" fill="#38362f">${title}</text>
              <rect x="28" y="78" width="240" height="9" rx="4" fill="#8f8d85"/>
              <rect x="28" y="102" width="370" height="7" rx="3" fill="#e2e0d9"/>
              <rect x="28" y="122" width="322" height="7" rx="3" fill="#e2e0d9"/>
              <rect x="28" y="154" width="424" height="154" rx="6" fill="#faf9f7" stroke="#e2e0d9"/>
              <text x="44" y="184" font-family="monospace" font-size="12" fill="#5f5d55">Reference transcript</text>
              <path d="M44 206h290M44 226h342M44 246h262M44 266h310" stroke="#d0cec7" stroke-width="6"/>
            </svg>`)
          })
        },
      },
    ],
  }),
)
