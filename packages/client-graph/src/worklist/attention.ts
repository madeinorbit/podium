import { compareStructural } from 'mobx'
import { lazy, companion } from '@podium/mobx-helpers'
import { createIdentityQuery } from '../query-result'
import { aggregateFields, type Aggregate, type RollupInputs } from './rollup'
import type { SidebarSessionFacts } from './sidebar-row'
import type { WorklistIssue } from './issue'

const sessionIds = companion((part: AttentionFields) => part.createSessionQuery())

/** Narrow cached answers for one roll-up input path. Both filing and drawn
 * rows reuse this implementation; it holds no issue or session facts. */
export class AttentionFields {
  constructor(readonly row: WorklistIssue, private readonly inputs: () => RollupInputs) {}
  get id() { return this.row.id }
  private readAggregate(): Aggregate { return aggregateFields(this.inputs(), this.row.id, this.row) }
  get value(): Aggregate {
    const model = this
    return {
      get railWaiting() { return model.aggregateRailWaiting },
      get sessionIds() { return model.aggregateSessionIds },
      get sidebarFacts() { return model.aggregateSidebarFacts },
      get updatedAt() { return model.aggregateUpdatedAt },
      get order() { return model.row.ownAttention.order },
      get decidingAt() { return model.aggregateDecidingAt },
      get seated() { return model.aggregateSeated },
      get working() { return model.aggregateWorking },
      get deciding() { return model.aggregateDeciding },
      get open() { return model.aggregateOpen },
      get finished() { return model.aggregateFinished },
      get pending() { return model.aggregatePending },
    }
  }

  private get aggregateRailWaiting(): NonNullable<Aggregate['railWaiting']> | undefined {
    const model = this
    return {
      get open() { return model.aggregateRailWaitingOpen },
      get finished() { return model.aggregateRailWaitingFinished },
      get decisions() { return model.aggregateRailWaitingDecisions },
    }
  }

  @lazy
  private get aggregateRailWaitingOpen(): NonNullable<Aggregate['railWaiting']>['open'] {
    return this.readAggregate().railWaiting!.open
  }

  @lazy
  private get aggregateRailWaitingFinished(): NonNullable<Aggregate['railWaiting']>['finished'] {
    return this.readAggregate().railWaiting!.finished
  }

  @lazy
  private get aggregateRailWaitingDecisions(): NonNullable<Aggregate['railWaiting']>['decisions'] {
    return this.readAggregate().railWaiting!.decisions
  }

  private get aggregateSessionIds(): Aggregate['sessionIds'] {
    return sessionIds(this).get()
  }

  /** @internal The roll-up's ordered identities, maintained by the data query. */
  createSessionQuery() {
    return createIdentityQuery({ name: `attention@${this.id}.sessions`,
      ids: () => this.readAggregate().sessionIds ?? [] })
  }

  private get aggregateSidebarFacts(): SidebarSessionFacts | undefined {
    const model = this
    return {
      get fleet() { return model.aggregateSidebarFactsFleet },
      get working() { return model.aggregateSidebarFactsWorking },
      get waitingOpen() { return model.aggregateSidebarFactsWaitingOpen },
      get waitingFinished() { return model.aggregateSidebarFactsWaitingFinished },
      get doneSince() { return model.aggregateSidebarFactsDoneSince },
      get totalMs() { return model.aggregateSidebarFactsTotalMs },
      get errorClass() { return model.aggregateSidebarFactsErrorClass },
      get allUnstarted() { return model.aggregateSidebarFactsAllUnstarted },
    }
  }
  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsFleet(): SidebarSessionFacts['fleet'] {
    return this.readAggregate().sidebarFacts!.fleet
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsWorking(): SidebarSessionFacts['working'] {
    return this.readAggregate().sidebarFacts!.working
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsWaitingOpen(): SidebarSessionFacts['waitingOpen'] {
    return this.readAggregate().sidebarFacts!.waitingOpen
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsWaitingFinished(): SidebarSessionFacts['waitingFinished'] {
    return this.readAggregate().sidebarFacts!.waitingFinished
  }

  @lazy
  private get aggregateSidebarFactsDoneSince(): SidebarSessionFacts['doneSince'] {
    return this.readAggregate().sidebarFacts!.doneSince
  }

  @lazy
  private get aggregateSidebarFactsTotalMs(): SidebarSessionFacts['totalMs'] {
    return this.readAggregate().sidebarFacts!.totalMs
  }

  @lazy
  private get aggregateSidebarFactsErrorClass(): SidebarSessionFacts['errorClass'] {
    return this.readAggregate().sidebarFacts!.errorClass
  }

  @lazy
  private get aggregateSidebarFactsAllUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return this.readAggregate().sidebarFacts!.allUnstarted
  }
  @lazy
  private get aggregateUpdatedAt(): Aggregate['updatedAt'] {
    return this.readAggregate().updatedAt
  }

  @lazy
  private get aggregateDecidingAt(): Aggregate['decidingAt'] {
    return this.readAggregate().decidingAt
  }

  @lazy
  private get aggregateSeated(): Aggregate['seated'] {
    return this.readAggregate().seated
  }

  @lazy
  private get aggregateWorking(): Aggregate['working'] {
    return this.readAggregate().working
  }

  @lazy
  private get aggregateDeciding(): Aggregate['deciding'] {
    return this.readAggregate().deciding
  }

  private get aggregateOpen(): import('./rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.aggregateOpenWaiting },
      get working() { return model.aggregateOpenWorking },
      get allDone() { return model.aggregateOpenAllDone },
    }
  }

  @lazy
  private get aggregateOpenWaiting(): import('./rollup').PhaseFlags['waiting'] {
    return this.readAggregate().open.waiting
  }
  @lazy
  private get aggregateOpenWorking(): import('./rollup').PhaseFlags['working'] {
    return this.readAggregate().open.working
  }

  @lazy
  private get aggregateOpenAllDone(): import('./rollup').PhaseFlags['allDone'] {
    return this.readAggregate().open.allDone
  }

  private get aggregateFinished(): import('./rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.aggregateFinishedWaiting },
      get working() { return model.aggregateFinishedWorking },
      get allDone() { return model.aggregateFinishedAllDone },
    }
  }

  @lazy
  private get aggregateFinishedWaiting(): import('./rollup').PhaseFlags['waiting'] {
    return this.readAggregate().finished.waiting
  }

  @lazy
  private get aggregateFinishedWorking(): import('./rollup').PhaseFlags['working'] {
    return this.readAggregate().finished.working
  }

  @lazy
  private get aggregateFinishedAllDone(): import('./rollup').PhaseFlags['allDone'] {
    return this.readAggregate().finished.allDone
  }

  @lazy
  private get aggregatePending(): Aggregate['pending'] {
    return this.readAggregate().pending
  }
}
