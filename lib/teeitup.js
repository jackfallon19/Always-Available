// TeeItUp adapter.
//
// TeeItUp booking sites (<alias>.book.teeitup.com) are a Next.js front end over a
// public JSON API. Every request needs an `x-be-alias: <alias>` header, which is how
// the API knows which operator's sites we're asking about. No auth is required.
//
//   GET {API}/facilities                                  -> the alias's courses (id, name, timeZone)
//   GET {API}/v2/tee-times?date=YYYY-MM-DD&facilityIds=1,2 -> one entry per facility, each with teetimes[]
//
// Times come back in UTC, prices in cents, and the API only returns tee times inside
// the operator's booking window; a date outside it looks identical to "sold out".

const API_BASE = 'https://phx-api-be-east-1b.kenna.io'
const TIMEOUT_MS = 10_000

// facilities rarely change; cache per alias for the life of the process/function instance
const facilityCache = new Map()

/** `forest-preserve-golf.book.teeitup.com` -> `forest-preserve-golf` */
export function aliasFor(course) {
  if (course.teeitup_alias) return course.teeitup_alias
  if (!course.booking_url) throw new Error(`${course.name} has no booking_url`)
  const host = new URL(course.booking_url).hostname
  const m = host.match(/^(.+?)\.(?:book|book-v2|play)\.teeitup\.(?:com|golf)$/)
  if (!m) {
    throw new Error(
      `Can't derive a TeeItUp alias from ${course.booking_url} (${course.name}); set course.teeitup_alias`,
    )
  }
  return m[1]
}

async function api(alias, path, params, attempt = 0) {
  const url = new URL(path, API_BASE)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  try {
    const res = await fetch(url, {
      headers: { 'x-be-alias': alias, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status >= 500 && attempt === 0) throw Object.assign(new Error('retry'), { retry: true })
    if (!res.ok) {
      throw new Error(`TeeItUp ${alias} ${url.pathname} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return await res.json()
  } catch (err) {
    // the API throws the odd transient 500; one quick retry clears nearly all of them
    if (attempt === 0 && (err.retry || err.name === 'TimeoutError')) {
      await new Promise((r) => setTimeout(r, 300))
      return api(alias, path, params, 1)
    }
    throw err
  }
}

async function facilitiesFor(alias) {
  if (!facilityCache.has(alias)) {
    // cache the promise so concurrent callers share one request; drop it on failure
    facilityCache.set(
      alias,
      api(alias, '/facilities').catch((err) => {
        facilityCache.delete(alias)
        throw err
      }),
    )
  }
  return facilityCache.get(alias)
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/golf (course|club|links)|\bg\.?c\.?\b|\bthe\b/g, '')
    .replace(/[^a-z0-9]+/g, '')

/** Find the TeeItUp facility that corresponds to a courses.json entry. */
async function resolveFacility(alias, course) {
  const facilities = await facilitiesFor(alias)
  if (course.teeitup_facility_id) {
    const f = facilities.find((f) => f.id === course.teeitup_facility_id)
    if (f) return f
  }
  if (facilities.length === 1) return facilities[0]
  const want = norm(course.name)
  const exact = facilities.filter((f) => norm(f.name) === want)
  if (exact.length === 1) return exact[0]
  const loose = facilities.filter((f) => norm(f.name).includes(want) || want.includes(norm(f.name)))
  if (loose.length === 1) return loose[0]
  // "Green Garden – Gold Course" vs "Green Garden Country Club - Gold Course": all our words appear in theirs
  const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const wantWords = words(course.name)
  const subset = facilities.filter((f) => {
    const have = new Set(words(f.name))
    return wantWords.every((w) => have.has(w))
  })
  if (subset.length === 1) return subset[0]
  throw new Error(
    `Couldn't match "${course.name}" to a ${alias} facility (${facilities.map((f) => f.name).join(', ')})`,
  )
}

function localTime(iso, timeZone) {
  // en-GB gives zero-padded 24h "HH:mm"
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(iso),
  )
}

function normalizeRate(r) {
  // the TeeItUp site prefers r.promotion's fees when present (never seen in the data so far)
  const fees = r.promotion ?? r
  const cents = fees.greenFeeCart ?? fees.greenFeeWalking
  return {
    name: r.name,
    price: cents == null ? null : cents / 100,
    walking: fees.greenFeeCart == null,
    holes: r.holes,
  }
}

function bookingUrl(course, facility, date) {
  const u = new URL(course.booking_url)
  return /\.teeitup\.(com|golf)$/.test(u.hostname)
    ? `${u.origin}/?course=${facility.id}&date=${date}` // site pre-selects that course on that date
    : course.booking_url
}

function normalizeTeeTime(tt, course, facility, date) {
  const rates = tt.rates.map(normalizeRate)
  const priced = rates.filter((r) => r.price != null)
  return {
    courseId: course.id,
    course: course.name,
    startsAt: tt.teetime, // UTC ISO
    time: localTime(tt.teetime, facility.timeZone), // course-local "HH:mm"
    openSpots: tt.maxPlayers, // most golfers that can still be added to this slot
    minPlayers: tt.minPlayers, // some slots need a party of 2+ (the site shows "2 - 4")
    holes: Math.max(...rates.map((r) => r.holes)),
    price: priced.length ? Math.min(...priced.map((r) => r.price)) : null, // USD per player, cheapest rate
    rates,
    // TeeItUp has no per-tee-time deep link (booking is a cart flow); on a TeeItUp host this opens
    // that course on that date, otherwise (embedded on the course's own site) the course's page
    bookingUrl: bookingUrl(course, facility, date),
    source: 'teeitup',
  }
}

/**
 * Tee times for several courses on one date. Courses that share a TeeItUp alias
 * are fetched with a single request. Per-course failures don't sink the rest.
 *
 * @param {string} date  YYYY-MM-DD, course-local
 * @param {object[]} courses  entries from courses.json
 * @returns {Promise<{teeTimes: object[], errors: {courseId: string, error: string}[]}>}
 */
export async function getTeeTimesForCourses(date, courses) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`)

  const teeTimes = []
  const errors = []
  const byAlias = new Map()
  for (const course of courses) {
    try {
      const alias = aliasFor(course)
      byAlias.set(alias, [...(byAlias.get(alias) ?? []), course])
    } catch (err) {
      errors.push({ courseId: course.id, error: err.message })
    }
  }

  await Promise.all(
    [...byAlias].map(async ([alias, group]) => {
      const resolved = []
      for (const course of group) {
        try {
          resolved.push({ course, facility: await resolveFacility(alias, course) })
        } catch (err) {
          errors.push({ courseId: course.id, error: err.message })
        }
      }
      if (!resolved.length) return
      try {
        const days = await api(alias, '/v2/tee-times', {
          date,
          facilityIds: resolved.map((r) => r.facility.id).join(','),
        })
        for (const { course, facility } of resolved) {
          const day = days.find((d) => d.courseId === facility.courseId)
          for (const tt of day?.teetimes ?? []) {
            if (tt.maxPlayers > 0) teeTimes.push(normalizeTeeTime(tt, course, facility, date))
          }
        }
      } catch (err) {
        for (const { course } of resolved) errors.push({ courseId: course.id, error: err.message })
      }
    }),
  )

  teeTimes.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.course.localeCompare(b.course))
  return { teeTimes, errors }
}

/** Tee times for one course on one date; throws if the request fails. */
export async function getTeeTimes(date, course) {
  const { teeTimes, errors } = await getTeeTimesForCourses(date, [course])
  if (errors.length) throw new Error(errors[0].error)
  return teeTimes
}
