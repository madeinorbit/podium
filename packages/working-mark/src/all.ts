/**
 * Every design, in the gallery's order, for pickers and galleries. Importing this pulls in all of them; an app that
 * ships one design imports it by name from '@podium/working-mark/designs' instead.
 */
import * as d from './designs'
import type { Design } from './types'

export const designGroups: readonly { title: string; designs: readonly Design[] }[] = [
  { title: 'The original', designs: [d.wave] },
  {
    title: 'Picks, pushed further',
    designs: [d.race, d.binary, d.binaryPrecess, d.haloGyre, d.haloFlip, d.haloSix],
  },
  {
    title: 'Most satisfying',
    designs: [d.tusi, d.pendulums, d.cradle, d.syzygy, d.click, d.halfTurn, d.bowl],
  },
  {
    title: 'Space',
    designs: [
      d.moons,
      d.electrons,
      d.tetra,
      d.eightOrbit,
      d.comet,
      d.blackhole,
      d.pulsar,
      d.trojans,
      d.tatooine,
    ],
  },
  {
    title: 'Natural phenomena',
    designs: [d.fireflySync, d.sunflower, d.waggle, d.mitosis, d.murmuration, d.drop],
  },
  {
    title: 'A formula underneath',
    designs: [d.knot, d.mobius, d.heart, d.snake, d.nautilus, d.globe, d.squircle, d.butterfly],
  },
  {
    title: 'Funky dots',
    designs: [d.juggle, d.chase, d.counter, d.vortex, d.twist, d.shuffle, d.fireflies],
  },
]

export const allDesigns: readonly Design[] = designGroups.flatMap((group) => group.designs)
