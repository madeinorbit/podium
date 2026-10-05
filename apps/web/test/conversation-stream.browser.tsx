/** Identical fixture copied into the untouched legacy revision by the runner. */
import { asUserId } from '@podium/model/browser'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool } from '../src/app/store-worklist-pool'
import { ChatView } from '../src/features/chat/ChatView'
import { createStreamFixture, installStreamDriver } from './conversation-stream-driver'
import '../src/index.css'
import '../src/styles.css'

const source = createStreamFixture()
const { fixture, id, errors, listeners } = source
const root = createRoot(document.getElementById('root')!)
document.documentElement.classList.add('dark')
document.body.style.margin = '0'
root.render(<StoreProvider
  principal={asClientPrincipal(asUserId('operator'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
  api={fixture.api} networkEnabled={false}
  createReplicaFn={() => source.replica()}
  onFatalError={error => errors.push(error)}
  attachRuntime={runtime => {
    fixture.bindHub(runtime.hub)
    fixture.publishMachines()
    runtime.hub.subscribeTranscript = (_id, _since, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    return attachWorklistPool(runtime, error => errors.push(error.message))
  }}>
  <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <ChatView sessionId={id} />
  </main>
</StoreProvider>)
installStreamDriver(source, () => root.unmount())
