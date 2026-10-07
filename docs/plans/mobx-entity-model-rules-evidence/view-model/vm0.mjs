import { observable } from 'mobx'
import { createViewModel } from './mu/create-view-model.js'
try { const d = createViewModel(observable({ a: 1 })); d.a = 2; console.log('plain observable object: works, draft.a =', d.a) } catch (e) { console.log('plain observable object: FAILS -', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')) }
