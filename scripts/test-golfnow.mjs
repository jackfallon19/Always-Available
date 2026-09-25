// Live check: node scripts/test-golfnow.mjs [YYYY-MM-DD]
//  1. GolfNow vs the TeeItUp adapter on Cook County (same underlying tee sheet) -> times/spots/prices must agree
//  2. sanity checks on GolfNow-only courses
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import * as golfnow from '../lib/golfnow.js'
import * as teeitup from '../lib/teeitup.js'

const courses = JSON.parse(readFileSync(new URL('../courses.json', import.meta.url)))
const date = process.argv[2] ?? new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

// 1. cross-check
const fpcc = courses.filter((c) => c.booking_url?.includes('forest-preserve-golf') && c.golfnow_facility_id)
const [gn, ti] = await Promise.all([golfnow.getTeeTimesForCourses(date, fpcc), teeitup.getTeeTimesForCourses(date, fpcc)])
assert.deepEqual([...gn.errors, ...ti.errors], [])
let mismatches = 0
for (const c of fpcc) {
  const a = new Map(gn.teeTimes.filter((t) => t.courseId === c.id).map((t) => [t.time, t]))
  const b = new Map(ti.teeTimes.filter((t) => t.courseId === c.id).map((t) => [t.time, t]))
  const onlyGn = [...a.keys()].filter((k) => !b.has(k)).length
  const onlyTi = [...b.keys()].filter((k) => !a.has(k)).length
  let diff = 0
  for (const [k, x] of a) {
    const y = b.get(k)
    if (y && (x.openSpots !== y.openSpots || x.minPlayers !== y.minPlayers || x.price !== y.price || x.startsAt !== y.startsAt)) {
      diff++
      if (diff <= 2) console.log('  diff', c.name, k, { gn: [x.openSpots, x.minPlayers, x.price, x.startsAt], ti: [y.openSpots, y.minPlayers, y.price, y.startsAt] })
    }
  }
  mismatches += onlyGn + onlyTi + diff
  console.log(`${c.name.padEnd(26)} gn ${String(a.size).padStart(3)}  ti ${String(b.size).padStart(3)}  onlyGN ${onlyGn} onlyTI ${onlyTi} fieldDiffs ${diff}`)
}
console.log(mismatches === 0 ? 'cross-check: identical' : `cross-check: ${mismatches} differences`)

// 2. GolfNow-only courses
const others = courses.filter((c) => c.golfnow_facility_id && !/^TeeItUp/.test(c.booking_system)).slice(0, 12)
const r = await golfnow.getTeeTimesForCourses(date, others)
console.log('\nGolfNow-only sample:', others.length, 'courses,', r.teeTimes.length, 'tee times,', r.errors.length, 'errors')
for (const e of r.errors) console.log('  err', e.courseId, e.error)
for (const t of r.teeTimes) {
  assert.match(t.time, /^\d{2}:\d{2}$/)
  assert.ok(t.openSpots >= t.minPlayers && t.openSpots <= 4)
  assert.ok(t.price == null || (t.price >= 0 && t.price < 400), `price ${t.price}`)
  assert.equal(new Date(t.startsAt).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), date)
}
console.log('sample:', JSON.stringify(r.teeTimes[0]))
