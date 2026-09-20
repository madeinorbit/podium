import { mountStub } from '../entrylib'

const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
mountStub('tanstack', 'pending POD-4448 (M1 TanStack DB arm)', sha)
