// GolfNow adapter.
//
// GolfNow's own site searches tee times with a public, unauthenticated JSON endpoint:
//   POST https://www.golfnow.com/api/tee-times/tee-time-search-results
// Multi-facility and area searches didn't work for us, so this is one request per course,
// keyed by course.golfnow_facility_id (filled in by scripts/find-golfnow-ids.mjs).
//
// Quirks:
//  - `time.date` is COURSE-LOCAL wall-clock time that carries a bogus "+00:00" suffix. Don't convert it.
//  - `playerRule` says which group sizes the slot accepts: OneTwo, TwoThreeFour, Any, ...
//  - Prices are GolfNow's; the online booking fee (`transactionFeesTotal`) is not included.

import { mapLimit, utcFromLocal } from './util.js'

const URL_ = 'https://www.golfnow.com/api/tee-times/tee-time-search-results'
const ORIGIN = 'https://www.golfnow.com'
const TIMEOUT_MS = 15_000
const PAGE_SIZE = 200
const CONCURRENCY = 10

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-09-27 -> "Sep 27 2026" */
const gnDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d} ${y}`
}

function requestBody(course, date, pageNumber) {
  return {
    pageSize: PAGE_SIZE,
    teeTimeCount: PAGE_SIZE,
    pageNumber,
    date: gnDate(date),
    sortBy: 'Date',
    sortByRollup: 'Date.MinDate',
    sortDirection: 0,
    hotDealsOnly: false,
    golfPassPerksOnly: false,
    bestDealsOnly: false,
    promotedCampaignsOnly: false,
    priceMin: 0,
    priceMax: 10000,
    players: 0,
    timePeriod: 'Any',
    timeMin: 10, // half-hour slots: 10 = 5:00 AM ... 42 = 9:00 PM (the site's "any time")
    timeMax: 42,
    holes: 'Any',
    facilityType: 'GolfCourse',
    latitude: course.lat,
    longitude: course.lon,
    radius: 35,
    facilityId: course.golfnow_facility_id,
    facilityIds: [],
    searchType: 'Facility',
    view: 'Grouping',
    excludeFeaturedFacilities: false,
    excludePrivateFacilities: false,
    rateType: 'all',
    currentClientDate: new Date().toISOString(),
  }
}

async function search(course, date, pageNumber) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify(requestBody(course, date, pageNumber)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GolfNow ${course.name} -> HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.ttResults) throw new Error(`GolfNow ${course.name}: unexpected response shape`)
  return json
}

/** "OneTwoThree" -> [1,2,3]; "Any" -> [1,2,3,4] */
function groupSizes(rule) {
  if (!rule || rule === 'Any') return [1, 2, 3, 4]
  const sizes = [...rule.matchAll(/One|Two|Three|Four/g)].map((m) => ({ One: 1, Two: 2, Three: 3, Four: 4 })[m[0]])
  return sizes.length ? sizes : [1, 2, 3, 4]
}

function normalizeRate(r) {
  const price = r.singlePlayerPrice?.greensFees?.value
  return {
    name: r.rateName,
    price: price == null ? null : price,
    walking: r.isCartIncluded === false,
    holes: r.holeCount,
  }
}

function normalizeTeeTime(tt, course) {
  const local = tt.time.date.slice(0, 16) // "2026-09-27T07:00"
  const rates = tt.teeTimeRates.map(normalizeRate)
  // teeTimeRates only lists the displayed rate (usually cart-included); the cheapest one is in minTeeTimeRate
  const lowest = tt.minTeeTimeRate?.value
  if (lowest != null && !rates.some((r) => r.price != null && r.price <= lowest)) {
    rates.push({ name: 'Lowest rate', price: lowest, walking: null, holes: rates[0].holes })
  }
  const priced = rates.filter((r) => r.price != null)
  const sizes = [...new Set([tt.playerRule, ...tt.teeTimeRates.map((r) => r.playerRule)].flatMap(groupSizes))].sort()
  return {
    courseId: course.id,
    course: course.name,
    startsAt: utcFromLocal(local, course.timezone ?? 'America/Chicago'),
    time: local.slice(11),
    openSpots: Math.max(...sizes),
    minPlayers: Math.min(...sizes),
    holes: Math.max(...rates.map((r) => r.holes)),
    price: priced.length ? Math.min(...priced.map((r) => r.price)) : null,
    rates,
    bookingUrl: `${ORIGIN}${tt.detailUrl}`, // GolfNow's page for this exact tee time
    source: 'golfnow',
  }
}

async function courseTeeTimes(date, course) {
  const out = []
  for (let page = 0; page < 5; page++) {
    const json = await search(course, date, page)
    const rows = json.ttResults.teeTimes ?? []
    for (const tt of rows) {
      // a facility can list several courses/rate sets; skip rows we can't read rather than fail the day
      if (tt.time?.date && tt.teeTimeRates?.length) out.push(normalizeTeeTime(tt, course))
    }
    if (rows.length < PAGE_SIZE) break
  }
  return out
}

/**
 * @param {string} date  YYYY-MM-DD, course-local
 * @param {object[]} courses  entries from courses.json that have golfnow_facility_id
 * @returns {Promise<{teeTimes: object[], errors: {courseId: string, error: string}[]}>}
 */
export async function getTeeTimesForCourses(date, courses) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`)
  const teeTimes = []
  const errors = []
  await mapLimit(courses, CONCURRENCY, async (course) => {
    try {
      if (!course.golfnow_facility_id) throw new Error(`${course.name} has no golfnow_facility_id`)
      teeTimes.push(...(await courseTeeTimes(date, course)))
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
