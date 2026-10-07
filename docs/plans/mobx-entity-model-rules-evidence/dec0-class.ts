import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { observable } = mobx as any
export const decCalls = () => 0
export class Dec {
  @observable accessor x = 0
  constructor(readonly id: number) { this.x = id }
}
