import { useEffect, useMemo, useRef, useState } from 'react'

const TZ = 'America/Chicago'

// YYYY-MM-DD for "today + n days" in Chicago
const dayOffset = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: TZ })
const DAYS = Array.from({ length: 8 }, (_, i) => dayOffset(i)) // booking windows are ~7 days

const chipLabel = (iso, i) => {
  const d = new Date(`${iso}T12:00:00`)
  return {
    top: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' }),
    bottom: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }
}

const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

const cheapest = (t) => t.rates.reduce((a, b) => (b.price != null && (a.price == null || b.price < a.price) ? b : a))

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

const SORTS = {
  time: (a, b) => a.startsAt.localeCompare(b.startsAt) || a.driveMin - b.driveMin,
  price: (a, b) => a.price - b.price || a.startsAt.localeCompare(b.startsAt),
  drive: (a, b) => a.driveMin - b.driveMin || a.startsAt.localeCompare(b.startsAt),
}

export default function App() {
  const [date, setDate] = useState(DAYS[1])
  const [players, setPlayers] = useState(4)
  const [holes, setHoles] = useState(18)
  const [from, setFrom] = useState('06:00')
  const [to, setTo] = useState('18:00')
  const [maxDrive, setMaxDrive] = useState(60)
  const [sort, setSort] = useState('time')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null) // a course picked from the finder list
  const [listOpen, setListOpen] = useState(true)
  const resultsRef = useRef(null)
  const [lo, setLo] = useState(0)
  const [hi, setHi] = useState(null) // null = no upper limit

  const [excluded, setExcluded] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('excludedCourses') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const [showCourses, setShowCourses] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(() => {
    try {
      return localStorage.getItem('favoritesOnly') === '1'
    } catch {
      return false
    }
  })

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    try {
      localStorage.setItem('favoritesOnly', favoritesOnly ? '1' : '0')
    } catch {}
  }, [favoritesOnly])

  useEffect(() => {
    try {
      localStorage.setItem('excludedCourses', JSON.stringify([...excluded]))
    } catch {}
  }, [excluded])

  const toggleCourse = (id) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    fetch(`/api/tee-times?date=${date}${favoritesOnly ? '&favorites=1' : ''}`, { signal: ctrl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
        return body
      })
      .then((body) => {
        setData(body)
        setLoading(false)
      })
      .catch((e) => {
        if (e.name === 'AbortError') return
        setError(e.message)
        setLoading(false)
      })
    return () => ctrl.abort()
  }, [date, favoritesOnly])

  // slider top end: highest price in the data, rounded up to $5
  const bound = useMemo(() => {
    const top = Math.max(0, ...(data?.teeTimes ?? []).map((t) => t.price ?? 0))
    return Math.max(50, Math.ceil(top / 5) * 5)
  }, [data])
  const effHi = Math.min(hi ?? bound, bound)

  // every course in courses.json, searched by name or city; words can be in any order ("glen ellyn links")
  const matches = useMemo(() => {
    const words = norm(query).split(' ').filter(Boolean)
    if (!words.length) return []
    return (data?.courses ?? [])
      .filter((c) => {
        const hay = norm(`${c.name} ${c.city}`)
        return words.every((w) => hay.includes(w))
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [data, query])
  const matchIds = useMemo(() => new Set(selected ? [selected] : matches.map((c) => c.id)), [matches, selected])
  const perCourse = useMemo(() => {
    const m = new Map()
    for (const t of data?.teeTimes ?? []) m.set(t.courseId, (m.get(t.courseId) ?? 0) + 1)
    return m
  }, [data])

  const searching = query.trim() !== ''

  const pickCourse = (c) => {
    setSelected(c.id)
    setQuery(c.name)
    setListOpen(false)
  }
  // once a course is picked, jump down to its tee times
  useEffect(() => {
    if (selected) resultsRef.current?.scrollIntoView({ block: 'start' })
  }, [selected])

  const results = useMemo(() => {
    if (!data) return []
    return data.teeTimes
      .filter(
        (t) =>
          t.minPlayers <= players &&
          t.openSpots >= players &&
          t.holes === holes &&
          t.time >= from &&
          t.time <= to &&
          (searching || t.driveMin <= maxDrive) && // a named course search overrides the drive limit
          (lo === 0 || (t.price != null && t.price >= lo)) &&
          (hi == null || (t.price != null && t.price <= hi)) &&
          !excluded.has(t.courseId) &&
          (!searching || matchIds.has(t.courseId)),
      )
      .sort(SORTS[sort])
  }, [data, players, holes, from, to, maxDrive, lo, hi, excluded, searching, matchIds, sort])

  const byName = (a, b) => a.name.localeCompare(b.name)
  const searchable = useMemo(() => (data?.courses ?? []).filter((c) => c.searched).sort(byName), [data])
  const other = useMemo(() => (data?.courses ?? []).filter((c) => !c.searchable).sort(byName), [data])

  const courseCount = new Set(results.map((t) => t.courseId)).size

  return (
    <main>
      <header>
        <h1>Tee times</h1>
        <p className="sub">Chicagoland public 18-hole courses · from 60614</p>
      </header>

      <div className="finder">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(null)
            setListOpen(true)
          }}
          onFocus={() => setListOpen(true)}
          onKeyDown={(e) => e.key === 'Escape' && setListOpen(false)}
          placeholder="Find a course or town (e.g. cog hill, glenview)"
          aria-label="Find a course"
        />
        {query.trim() && listOpen && (
          <ul className="matches">
            {matches.length === 0 && <li className="none">No course matches “{query.trim()}”.</li>}
            {matches.map((c) => {
              const n = perCourse.get(c.id) ?? 0
              return (
                <li key={c.id} className={c.searched ? 'pickable' : ''}>
                  {c.searched ? (
                    <button type="button" className="pick-row" onClick={() => pickCourse(c)}>
                      <div>
                        <strong>{c.name}</strong>
                        <small>{c.city} · {c.driveMin} min · {c.system}</small>
                      </div>
                      <span className={n ? 'tag ok' : 'tag'}>
                        {loading ? '…' : n ? `${n} tee time${n === 1 ? '' : 's'} on this date` : 'none listed this date'}
                      </span>
                    </button>
                  ) : (
                    <div>
                      <strong>{c.name}</strong>
                      <small>{c.city} · {c.driveMin} min · {c.system}</small>
                    </div>
                  )}
                  {c.searched ? null : c.searchable ? (
                    <span className="tag">Not a favorite · turn off Favorites to search</span>
                  ) : c.bookingUrl ? (
                    <a className="tag link" href={c.bookingUrl} target="_blank" rel="noreferrer">Not searchable here · book on their site ↗</a>
                  ) : (
                    <span className="tag">Not searchable · no online booking found</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="favbar">
        <button type="button" className={favoritesOnly ? 'fav on' : 'fav'} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}>
          <span aria-hidden="true">{favoritesOnly ? '★' : '☆'}</span> Favorites only
        </button>
        {favoritesOnly && data && (
          <small>
            Searching {data.courses.filter((c) => c.favorite && c.searched).length} favorite courses
            {data.courses.some((c) => c.favorite && !c.searchable) && (
              <>
                {' · can’t search: '}
                {data.courses
                  .filter((c) => c.favorite && !c.searchable)
                  .map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ', '}
                      {c.bookingUrl ? (
                        <a href={c.bookingUrl} target="_blank" rel="noreferrer">{c.name} ↗</a>
                      ) : (
                        c.name
                      )}
                    </span>
                  ))}
              </>
            )}
          </small>
        )}
      </div>

      <div className="days" role="tablist" aria-label="Date">
        {DAYS.map((d, i) => {
          const l = chipLabel(d, i)
          return (
            <button key={d} role="tab" aria-selected={d === date} className={d === date ? 'chip on' : 'chip'} onClick={() => setDate(d)}>
              <span>{l.top}</span>
              <small>{l.bottom}</small>
            </button>
          )
        })}
        <label className="pick" title="Pick any date">
          <span>Other date</span>
          <input
            type="date"
            min={DAYS[0]}
            value={DAYS.includes(date) ? '' : date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </label>
      </div>

      <section className="filters">
        <label>
          Golfers
          <select value={players} onChange={(e) => setPlayers(+e.target.value)}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Holes
          <select value={holes} onChange={(e) => setHoles(+e.target.value)}>
            <option value={18}>18</option>
            <option value={9}>9</option>
          </select>
        </label>
        <label>
          After
          <input type="time" step="900" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Before
          <input type="time" step="900" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Drive
          <select value={maxDrive} onChange={(e) => setMaxDrive(+e.target.value)}>
            {[20, 30, 45, 60, 90].map((n) => (
              <option key={n} value={n}>≤ {n} min</option>
            ))}
          </select>
        </label>
        <div className="price-range">
          <span>
            Price / golfer: <strong>{lo === 0 && hi == null ? 'any' : `$${lo} – ${hi == null ? `$${bound}+` : `$${hi}`}`}</strong>
          </span>
          <div className="dual">
            <div className="fill" style={{ left: `${(lo / bound) * 100}%`, right: `${100 - (effHi / bound) * 100}%` }} />
            <input
              type="range" min="0" max={bound} step="1" value={lo} aria-label="Minimum price"
              onChange={(e) => setLo(Math.min(+e.target.value, effHi))}
            />
            <input
              type="range" min="0" max={bound} step="1" value={effHi} aria-label="Maximum price"
              onChange={(e) => {
                const v = Math.max(+e.target.value, lo)
                setHi(v >= bound ? null : v)
              }}
            />
          </div>
        </div>
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="time">Earliest</option>
            <option value="price">Cheapest</option>
            <option value="drive">Closest</option>
          </select>
        </label>
      </section>

      {data && (
        <section className="courses">
          <button className="link" onClick={() => setShowCourses((v) => !v)}>
            {showCourses ? 'Hide' : 'Choose'} courses · {searchable.length - searchable.filter((c) => excluded.has(c.id)).length} of{' '}
            {searchable.length} searchable{excluded.size ? ` (${excluded.size} excluded)` : ''}
          </button>
          {showCourses && (
            <>
              <div className="bulk">
                <button className="link" onClick={() => setExcluded(new Set())}>Include all</button>
                <button className="link" onClick={() => setExcluded(new Set(searchable.map((c) => c.id)))}>Exclude all</button>
              </div>
              <ul className="courselist">
                {searchable.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input type="checkbox" checked={!excluded.has(c.id)} onChange={() => toggleCourse(c.id)} />
                      <span>{c.name}</span>
                      <small>{c.city} · {c.driveMin} min</small>
                    </label>
                  </li>
                ))}
              </ul>
              {other.length > 0 && (
                <>
                  <h2>Not searchable here yet ({other.length})</h2>
                  <p className="sub">Book these on their own sites:</p>
                  <ul className="courselist">
                    {other.map((c) => (
                      <li key={c.id}>
                        {c.bookingUrl ? (
                          <a href={c.bookingUrl} target="_blank" rel="noreferrer">
                            <span>{c.name}</span>
                            <small>{c.city} · {c.driveMin} min · {c.system}</small>
                          </a>
                        ) : (
                          <span>{c.name}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      )}

      {error && <p className="notice bad">Couldn’t load tee times: {error}</p>}
      {loading && <p className="notice">Checking courses…</p>}

      {!loading && data && (
        <>
          <p className="count" ref={resultsRef}>
            {results.length} tee time{results.length === 1 ? '' : 's'} at {courseCount} course{courseCount === 1 ? '' : 's'}
          </p>
          {results.length === 0 && (
            <p className="notice">
              {data.teeTimes.length === 0 && !DAYS.includes(date)
                ? 'No tee times posted for that date. Most courses only open times about a week ahead, so try again closer to the day.'
                : 'Nothing matches. Try fewer golfers, a wider time range, a longer drive or a wider price range.'}
            </p>
          )}
          <ul className="results">
            {results.map((t) => (
              <li key={t.courseId + t.startsAt}>
                <a href={t.bookingUrl} target="_blank" rel="noreferrer">
                  <div className="time">{fmtTime(t.time)}</div>
                  <div className="main">
                    <strong>{t.course}</strong>
                    <span>
                      {t.city} · {t.driveMin} min · {t.openSpots} open{t.minPlayers > 1 ? ` (min ${t.minPlayers})` : ''}
                      {t.source === 'golfnow' ? ' · via GolfNow' : ''}
                    </span>
                  </div>
                  <div className="price">
                    {t.price == null ? '—' : money(t.price)}
                    <small>{{ true: 'walking', false: 'riding' }[cheapest(t).walking] ?? ''}</small>
                  </div>
                </a>
              </li>
            ))}
          </ul>
          <footer>
            Prices are per golfer, cheapest rate, before online booking fees. “Via GolfNow” rows open GolfNow, which can
            show discounted rates and slightly different group sizes than the course’s own site.
            {data.errors.length > 0 && ` ${data.errors.length} course(s) failed to load.`}
            {data.unsupported.length > 0 && ` ${data.unsupported.length} courses can’t be searched yet; find them under Choose courses.`}
          </footer>
        </>
      )}
    </main>
  )
}
