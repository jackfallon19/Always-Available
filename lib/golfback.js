// GolfBack adapter.
//
//   POST https://api.golfback.com/api/v1/courses/<uuid>/date/YYYY-MM-DD/teetimes   (empty JSON body = everything)
//
// `localDateTime` is course-local. Each rate has basePrice (green fee) and price (basePrice + booking fee),
// so we report basePrice to stay comparable with the other adapters. Course uuid comes from the booking URL
// (golfback.com/#/course/<uuid>/) or course.golfback_course_id.

import { mapLimit, utcFromLocal } from './util.js'

const API = 'https://api.golfback.com/api/v1/courses'
const TIMEOUT_MS = 15_000
const CONCURRENCY = 6

export const golfbackId = (course) =>
  course.golfback_course_id ?? course.booking_url?.match(/course\/([0-9a-f-]{36})/i)?.[1]

async function search(id, date, name) {
  const res = await fetch(`${API}/${id}/date/${date}/teetimes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GolfBack ${name} -> HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json?.data)) throw new Error(`GolfBack ${name}: unexpected response shape`)
  return json.data
}

function normalizeTeeTime(tt, course) {
  const rates = (tt.rates ?? []).map((r) => ({
    name: r.name,
    price: r.basePrice ?? null,
    walking: r.hasCartIncluded == null ? null : !r.hasCartIncluded,
    holes: r.holes,
  }))
  const priced = rates.filter((r) => r.price != null)
  const holes = Math.max(...(tt.holes?.length ? tt.holes : rates.map((r) => r.holes)))
  const local = tt.localDateTime.slice(0, 16)
  return {
    courseId: course.id,
    course: course.name,
    startsAt: utcFromLocal(local, course.timezone ?? 'America/Chicago'),
    time: local.slice(11),
    openSpots: tt.playersMax ?? 4,
    minPlayers: tt.playersMin ?? 1,
    holes,
    price: priced.length ? Math.min(...priced.map((r) => r.price)) : null,
    rates,
    bookingUrl: course.booking_url,
    source: 'golfback',
  }
}

export async function getTeeTimesForCourses(date, courses) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`)
  const teeTimes = []
  const errors = []
  await mapLimit(courses, CONCURRENCY, async (course) => {
    try {
      const id = golfbackId(course)
      if (!id) throw new Error(`${course.name}: no GolfBack course id`)
      for (const tt of await search(id, date, course.name)) {
        if (tt.isAvailable !== false && (tt.playersMax ?? 1) > 0) teeTimes.push(normalizeTeeTime(tt, course))
      }
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
