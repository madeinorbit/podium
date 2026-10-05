/** Phone web path with real chat, pool, transcript viewport and composer. */
import { StoreProvider } from '@podium/client-core/react'
import { asClientPrincipal } from '@podium/client-core/principal'
import { asUserId } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { attachMobilePool } from '../src/client/mobile-pool'
import { SessionConversation } from '../src/components/SessionConversation'
import { useSessionContextSession } from '../src/client/use-session-context'
import { createStreamFixture, installStreamDriver } from '../../web/test/conversation-stream-driver'
import type { MobileTrpc } from '../src/client/trpc'

const source = createStreamFixture()
const { fixture, errors, listeners } = source
function Surface() {
  const session = useSessionContextSession(source.id)
  return session ? <SessionConversation session={session} issue={undefined} /> : null
}
const root = createRoot(document.getElementById('root')!)
document.body.style.cssText = 'margin:0;background:#16191e;color:#eee'
root.render(<StoreProvider
  principal={asClientPrincipal(asUserId('operator'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
  api={fixture.api as unknown as MobileTrpc} networkEnabled={false}
  createReplicaFn={() => source.replica()}
  onFatalError={error => errors.push(error)}
  attachRuntime={runtime => {
    fixture.bindHub(runtime.hub)
    fixture.publishMachines()
    runtime.hub.subscribeTranscript = (_id, _since, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    return attachMobilePool(runtime, error => errors.push(error.message))
  }}>
  <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}><Surface /></main>
</StoreProvider>)
installStreamDriver(source, () => root.unmount())
