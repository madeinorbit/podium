import { mountStub } from '../entrylib'

const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
mountStub('hand', 'pending POD-4446 (M1 hand-rolled arm)', sha)
