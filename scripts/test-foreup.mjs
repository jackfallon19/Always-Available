// Live check: node scripts/test-foreup.mjs [YYYY-MM-DD]
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getTeeTimesForCourses, getTeeTimes } from '../lib/foreup.js'

const courses = JSON.parse(readFileSync(new URL('../courses.json', import.meta.url))).filter((c) => c.foreup_schedule_id)
const date = process.argv[2] ?? new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
console.log(`${courses.length} foreUP courses, ${date}\n`)

const { teeTimes, errors } = await getTeeTimesForCourses(date, courses)
assert.deepEqual(errors, [])
for (const c of courses) {
  const t = teeTimes.filter((x) => x.courseId === c.id)
  const prices = t.map((x) => x.price)
  console.log(`${c.name.padEnd(36)} ${String(t.length).padStart(3)} times  ${t[0]?.time ?? '-'}..${t.at(-1)?.time ?? '-'}  $${Math.min(...prices)}-$${Math.max(...prices)}`)
}
for (const t of teeTimes) {
  assert.match(t.time, /^\d{2}:\d{2}$/)
  assert.ok(t.openSpots >= 1 && t.openSpots <= 4 && t.minPlayers >= 1 && t.minPlayers <= t.openSpots, JSON.stringify(t))
  assert.ok([9, 18].includes(t.holes))
  assert.ok(t.price > 0 && t.price < 400, `price ${t.price}`)
  assert.equal(new Date(t.startsAt).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), date)
}
assert.deepEqual(await getTeeTimes(date, courses[0]), teeTimes.filter((x) => x.courseId === courses[0].id))
console.log('\nsample:', JSON.stringify(teeTimes[0]))
console.log(`OK: ${teeTimes.length} tee times validated`)
