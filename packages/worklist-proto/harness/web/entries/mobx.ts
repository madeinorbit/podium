import { mountStub } from '../entrylib'

const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
mountStub('mobx', 'pending POD-4447 (M1 MobX arm)', sha)
