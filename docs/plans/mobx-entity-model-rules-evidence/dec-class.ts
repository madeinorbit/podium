import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { observable, computed } = mobx as any
let calls = 0
export const decCalls = () => calls
export class Dec {
  @observable accessor x = 0
  constructor(readonly id: number) { this.x = id }
  @computed get c0() { calls++; return this.x + 0 }
  @computed get c1() { calls++; return this.x + 1 }
  @computed get c2() { calls++; return this.x + 2 }
  @computed get c3() { calls++; return this.x + 3 }
  @computed get c4() { calls++; return this.x + 4 }
  @computed get c5() { calls++; return this.x + 5 }
  @computed get c6() { calls++; return this.x + 6 }
  @computed get c7() { calls++; return this.x + 7 }
  @computed get c8() { calls++; return this.x + 8 }
  @computed get c9() { calls++; return this.x + 9 }
  @computed get c10() { calls++; return this.x + 10 }
  @computed get c11() { calls++; return this.x + 11 }
  @computed get c12() { calls++; return this.x + 12 }
  @computed get c13() { calls++; return this.x + 13 }
  @computed get c14() { calls++; return this.x + 14 }
  @computed get c15() { calls++; return this.x + 15 }
  @computed get c16() { calls++; return this.x + 16 }
  @computed get c17() { calls++; return this.x + 17 }
  @computed get c18() { calls++; return this.x + 18 }
  @computed get c19() { calls++; return this.x + 19 }
  @computed get c20() { calls++; return this.x + 20 }
  @computed get c21() { calls++; return this.x + 21 }
  @computed get c22() { calls++; return this.x + 22 }
  @computed get c23() { calls++; return this.x + 23 }
  @computed get c24() { calls++; return this.x + 24 }
  @computed get c25() { calls++; return this.x + 25 }
  @computed get c26() { calls++; return this.x + 26 }
  @computed get c27() { calls++; return this.x + 27 }
  @computed get c28() { calls++; return this.x + 28 }
  @computed get c29() { calls++; return this.x + 29 }
}
