// TeeQuest adapter (server-rendered ASP.NET pages, no JSON API).
//
//   GET  https://teetimes.teequest.com/<site>          -> session cookie
//   POST https://teetimes.teequest.com/<site>          form: Search.CourseTag, Search.Date, Search.Time, Search.Players
//
// The response is HTML; each tee time is an <li> with the time, a rate, a description ("18 holes with cart")
// and four buttons, book-1..book-4, marked `available` for each party size that still fits. Prepaid and
// pay-at-course rates come back as separate entries for the same time, so we merge them into one tee time.
// Config in courses.json: teequest_site ("109") and teequest_course_tag ("109-1"); the site's pages show
// prices per person including cart and tax, with no booking fee.

import { mapLimit, utcFromLocal } from './util.js'

const ORIGIN = 'https://teetimes.teequest.com'
const TIMEOUT_MS = 15_000

const cookieHeader = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

/** "9/27/2026 12:00:00 AM" -- the format the form's date select posts */
const formDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${m}/${d}/${y} 12:00:00 AM`
}

async function search(course, date) {
  const site = course.teequest_site
  const first = await fetch(`${ORIGIN}/${site}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!first.ok) throw new Error(`TeeQuest ${course.name} -> HTTP ${first.status}`)
  const res = await fetch(`${ORIGIN}/${site}`, {
    method: 'POST',
    headers: { 'user-agent': 'Mozilla/5.0', 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(first) },
    body: new URLSearchParams({
      PaymentTab: 'pay-online',
      'Search.CourseTag': course.teequest_course_tag,
      'Search.Date': formDate(date),
      'Search.Time': 'Anytime',
      'Search.Players': '0',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`TeeQuest ${course.name} search -> HTTP ${res.status}`)
  return res.text()
}

const to24h = (t) => {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i)
  if (!m) return null
  const h = (Number(m[1]) % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

export function parse(html, course, date) {
  const byTime = new Map()
  const items = html.split('<div class="tee-time').slice(1)
  for (const chunk of items) {
    const mode = chunk.match(/^\s*([a-z -]*)"/)?.[1]?.trim() ?? ''
    const time = to24h(chunk.match(/class="time-only">([^<]+)</)?.[1] ?? '')
    const price = Number(chunk.match(/class="rate">\$([\d.,]+)</)?.[1]?.replace(',', ''))
    const desc = (chunk.match(/class="booking-desc">\s*([^<]+?)\s*</)?.[1] ?? '').trim()
    const spots = [1, 2, 3, 4].filter((n) => new RegExp(`book-${n} available`).test(chunk))
    if (!time || !Number.isFinite(price) || !spots.length) continue
    const holes = /9\s*holes/i.test(desc) ? 9 : 18
    const rate = { name: `${desc || 'Green fee'}${/online/.test(mode) ? ' (prepaid)' : ''}`.trim(), price, walking: /cart|ride|riding/i.test(desc) ? false : /walk/i.test(desc) ? true : null, holes }
    const cur = byTime.get(time) ?? { time, spots: [], rates: [] }
    cur.spots = [...new Set([...cur.spots, ...spots])].sort()
    cur.rates.push(rate)
    byTime.set(time, cur)
  }
  return [...byTime.values()].map((t) => ({
    courseId: course.id,
    course: course.name,
    startsAt: utcFromLocal(`${date}T${t.time}`, course.timezone ?? 'America/Chicago'),
    time: t.time,
    openSpots: Math.max(...t.spots),
    minPlayers: Math.min(...t.spots),
    holes: Math.max(...t.rates.map((r) => r.holes)),
    price: Math.min(...t.rates.map((r) => r.price)),
    rates: t.rates,
    bookingUrl: course.booking_url,
    source: 'teequest',
  }))
}

export async function getTeeTimesForCourses(date, courses) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`)
  const teeTimes = []
  const errors = []
  await mapLimit(courses, 4, async (course) => {
    try {
      teeTimes.push(...parse(await search(course, date), course, date))
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
