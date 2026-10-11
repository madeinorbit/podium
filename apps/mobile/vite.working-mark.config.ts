import { resolve } from 'node:path'
import conversation from './vite.conversation-stream.config'

export default async () => {
  const config = await conversation()
  config.optimizeDeps.entries = ['test/working-mark.browser.html']
  config.build.rolldownOptions.input = resolve(import.meta.dirname, 'test/working-mark.browser.html')
  config.server.port = 45174
  return config
}
