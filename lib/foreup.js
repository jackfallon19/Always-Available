// foreUP adapter.
//
// foreUP's booking pages (foreupsoftware.com/index.php/booking/<course>/<schedule>) call a public JSON endpoint:
//   GET /index.php/api/booking/times?date=MM-DD-YYYY&schedule_id=N&schedule_ids[]=N&api_key=no_limits&...
// No login. One request per tee sheet ("schedule"); courses.json carries it as foreup_schedule_id.
//
// Quirks:
//  - `time` is course-local "YYYY-MM-DD HH:mm".
//  - Some sheets offer 9 or 18 holes (`holes` is "9/18"); we report 18 when it's offered.
//  - Cart is sometimes a separate fee (`cart_fee`), sometimes 0 (included, or not offered), so cart-ness is unknown then.

import { mapLimit, utcFromLocal } from './util.js'

const API = 'https://foreupsoftware.com/index.php/api/booking/times'
const TIMEOUT_MS = 15_000
const CONCURRENCY = 8

async function search(course, date) {
  const [y, m, d] = date.split('-')
  const id = course.foreup_schedule_id
  const url =
    `${API}?time=all&date=${m}-${d}-${y}&holes=all&players=0&booking_class=&schedule_id=${id}` +
    `&schedule_ids%5B%5D=${id}&specials_only=0&api_key=no_limits`
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`foreUP ${course.name} -> HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json)) throw new Error(`foreUP ${course.name}: ${String(json?.error ?? 'unexpected response').slice(0, 100)}`)
  return json
}

function normalizeTeeTime(tt, course) {
  const offers18 = String(tt.holes).includes('18')
  const holes = offers18 ? 18 : 9
  const green = (offers18 ? tt.green_fee_18 : tt.green_fee_9) || tt.green_fee || null
  const cart = (offers18 ? tt.cart_fee_18 : tt.cart_fee_9) || tt.cart_fee || 0
  const rates = []
  if (green != null) {
    rates.push({ name: cart > 0 ? 'Walking' : 'Green fee', price: green, walking: cart > 0 ? true : null, holes })
    if (cart > 0) rates.push({ name: 'With cart', price: +(green + cart).toFixed(2), walking: false, holes })
  }
  const groups = (tt.allowed_group_sizes ?? []).map(Number).filter(Boolean)
  const spots = (offers18 ? tt.available_spots_18 : tt.available_spots_9) || tt.available_spots
  const local = tt.time.replace(' ', 'T') // "2026-09-27T15:15"
  return {
    courseId: course.id,
    course: course.name,
    startsAt: utcFromLocal(local, course.timezone ?? 'America/Chicago'),
    time: local.slice(11, 16),
    openSpots: Math.min(spots, 4),
    minPlayers: groups.length ? Math.min(...groups) : tt.minimum_players || 1,
    holes,
    price: green,
    rates,
    bookingUrl: course.booking_url, // foreUP has no per-tee-time link
    source: 'foreup',
  }
}

/**
 * @param {string} date  YYYY-MM-DD, course-local
 * @param {object[]} courses  entries from courses.json that have foreup_schedule_id
 */
export async function getTeeTimesForCourses(date, courses) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`)
  const teeTimes = []
  const errors = []
  await mapLimit(courses, CONCURRENCY, async (course) => {
    try {
      if (!course.foreup_schedule_id) throw new Error(`${course.name} has no foreup_schedule_id`)
      for (const tt of await search(course, date)) if (tt.available_spots > 0) teeTimes.push(normalizeTeeTime(tt, course))
    } catch (err) {
      errors.push({ courseId: course.id, error: err.message })
    }
  })
  teeTimes.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.course.localeCompare(b.course))
  return { teeTimes, errors }
}

export async function getTeeTimes(date, course) {
  const { teeTimes, errors } = await getTeeTimesForCourses(date, [course])
  if (errors.length) throw new Error(errors[0].error)
  return teeTimes
}
