// Platform-independent handler for GET /api/tee-times?date=YYYY-MM-DD[&courses=id1,id2][&players=2][&holes=18]
//   courses  courses.json ids (default: every course we have an adapter for)
//   players  only slots with at least this many open spots
//   holes    9 or 18
// Returns { status, body, cache }; the Netlify and Vercel entry points just adapt that to their runtime.
import courses from '../courses.json' with { type: 'json' }
import { getTeeTimesForCourses as teeitup } from './teeitup.js'
import { getTeeTimesForCourses as golfnow } from './golfnow.js'
import { getTeeTimesForCourses as foreup } from './foreup.js'
import { getTeeTimesForCourses as golfback, golfbackId } from './golfback.js'
import { getTeeTimesForCourses as teequest } from './teequest.js'

const byId = new Map(courses.map((c) => [c.id, c]))

// A course goes to the first adapter that claims it. Its own booking system first, GolfNow (which lists most
// courses) as the fallback.
const isTeeItUp = (c) => /^TeeItUp/.test(c.booking_system) && c.status === 'open'
const adapters = [
  { match: isTeeItUp, fetch: teeitup },
  { match: (c) => !isTeeItUp(c) && c.status === 'open' && c.foreup_schedule_id, fetch: foreup },
  { match: (c) => c.status === 'open' && c.booking_system === 'GolfBack' && golfbackId(c), fetch: golfback },
  { match: (c) => c.status === 'open' && c.teequest_site, fetch: teequest },
  { match: (c) => !isTeeItUp(c) && c.status === 'open' && !c.foreup_schedule_id && c.golfnow_facility_id, fetch: golfnow },
  // Add new booking systems here as their adapters get written.
]

const NO_CACHE = 'no-store'
// short edge cache: tee times churn, but many friends hitting the same search shouldn't hammer the booking systems
const EDGE_CACHE = 'public, max-age=0, s-maxage=60'

/** @param {URLSearchParams} q */
export async function searchTeeTimes(q) {
  const fail = (error) => ({ status: 400, body: { error }, cache: NO_CACHE })

  const date = q.get('date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return fail('date=YYYY-MM-DD is required')

  const ids = q.get('courses')?.split(',').filter(Boolean)
  const minSpots = Number(q.get('players') ?? 1)
  const holes = q.get('holes') ? Number(q.get('holes')) : null
  if (!Number.isInteger(minSpots) || minSpots < 1 || minSpots > 4) return fail('players must be 1-4')

  const wanted = ids ? courses.filter((c) => ids.includes(c.id)) : courses
  const unknown = ids?.filter((id) => !courses.some((c) => c.id === id)) ?? []
  if (unknown.length) return fail(`unknown course ids: ${unknown.join(', ')}`)

  const results = await Promise.all(adapters.map((a) => a.fetch(date, wanted.filter(a.match))))
  const errors = results.flatMap((r) => r.errors)
  const supported = new Set(adapters.flatMap((a) => wanted.filter(a.match).map((c) => c.id)))
  const unsupported = wanted.filter((c) => !supported.has(c.id)).map((c) => c.id)

  const teeTimes = results
    .flatMap((r) => r.teeTimes)
    .map((t) => ({ ...t, city: byId.get(t.courseId).city, driveMin: byId.get(t.courseId).drive_min_est }))
    .filter((t) => t.openSpots >= minSpots && (holes == null || t.holes === holes))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.course.localeCompare(b.course))

  const courseList = courses.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    driveMin: c.drive_min_est,
    system: c.booking_system,
    bookingUrl: c.booking_url,
    searchable: supported.has(c.id),
  }))

  return { status: 200, body: { date, teeTimes, errors, unsupported, courses: courseList }, cache: EDGE_CACHE }
}
