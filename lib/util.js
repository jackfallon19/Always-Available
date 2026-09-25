// Helpers shared by the booking-system adapters.

/** UTC ISO for a wall-clock "YYYY-MM-DDTHH:mm" in an IANA time zone. */
export function utcFromLocal(local, timeZone) {
  const asUtc = Date.parse(`${local}:00Z`)
  const offsetAt = (ms) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    )
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms
  }
  let ms = asUtc - offsetAt(asUtc)
  ms = asUtc - offsetAt(ms) // second pass handles the DST boundary
  return new Date(ms).toISOString()
}

/** Bounded-concurrency map so ~90 courses don't all hit GolfNow at once. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
      }
    }),
  )
  return results
}
