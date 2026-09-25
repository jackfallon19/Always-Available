// Live smoke test: node scripts/test-teeitup.mjs [YYYY-MM-DD]
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getTeeTimes, getTeeTimesForCourses } from '../lib/teeitup.js'

const courses = JSON.parse(readFileSync(new URL('../courses.json', import.meta.url)))
const fpcc = courses.filter((c) => c.booking_url?.includes('forest-preserve-golf.book.teeitup.com'))

// default: 3 days out, inside the ~7-day window
const d = new Date(Date.now() + 3 * 864e5)
const date = process.argv[2] ?? d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

console.log(`${fpcc.length} Cook County courses, ${date}\n`)

const { teeTimes, errors } = await getTeeTimesForCourses(date, fpcc)
assert.deepEqual(errors, [], 'no per-course errors')

for (const c of fpcc) {
  const t = teeTimes.filter((x) => x.courseId === c.id)
  console.log(`${c.name.padEnd(26)} ${String(t.length).padStart(3)} times  ${t[0]?.time ?? '-'} .. ${t.at(-1)?.time ?? '-'}`)
  if (t.length === 0) console.log(`  (note: ${c.name} has no tee times on ${date}; can be genuine, e.g. an outing or a closed day)`)
}

assert.ok(teeTimes.length > 50, 'expected a healthy number of tee times across 8 courses')

console.log('\nsample:', JSON.stringify(teeTimes[0], null, 2))

// shape / sanity checks on every record
for (const t of teeTimes) {
  assert.match(t.time, /^\d{2}:\d{2}$/)
  assert.ok(t.openSpots >= 1 && t.openSpots <= 4, `openSpots ${t.openSpots}`)
  assert.ok([9, 18].includes(t.holes))
  assert.ok(typeof t.price === 'number' && t.price > 0 && t.price < 300, `price ${t.price}`)
  assert.match(t.bookingUrl, new RegExp(`^https://forest-preserve-golf\\.book\\.teeitup\\.com/\\?course=\\d+&date=${date}$`))
  assert.ok(t.minPlayers >= 1 && t.minPlayers <= t.openSpots)
  // local date of the slot must be the requested date (catches UTC/local mix-ups)
  const local = new Date(t.startsAt).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  assert.equal(local, date)
}

// single-course entry point agrees with the batch one
const one = await getTeeTimes(date, fpcc[0])
assert.deepEqual(one, teeTimes.filter((x) => x.courseId === fpcc[0].id))

console.log(`\nOK: ${teeTimes.length} tee times validated`)
