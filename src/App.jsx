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

const readJson = (key) => {
  try {
    const v = localStorage.getItem(key)
    return v == null ? null : JSON.parse(v)
  } catch {
    return null
  }
}
const cleanIds = (list) => [...new Set((list ?? []).filter((x) => typeof x === 'string' && /^[a-z0-9-]{1,80}$/.test(x)))].slice(0, 300)

function Star({ on, name, onClick }) {
  return (
    <button
      type="button"
      className={on ? 'star on' : 'star'}
      aria-pressed={on}
      aria-label={`${on ? 'Remove' : 'Add'} ${name} ${on ? 'from' : 'to'} favorites`}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={onClick}
    >
      {on ? '★' : '☆'}
    </button>
  )
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
  // The user's own favorites (course ids). null = never customized, so the defaults flagged in courses.json apply.
  const [custom, setCustom] = useState(() => {
    const saved = readJson('favoriteCourses')
    return Array.isArray(saved) ? cleanIds(saved) : null
  })
  const [showFavs, setShowFavs] = useState(false)
  const [favAdd, setFavAdd] = useState('') // the "add a course" box in the favorites editor
  const [shareNote, setShareNote] = useState(null) // 'Link copied' or the link itself when copying is blocked
  // a favorites link someone sent: /?fav=id1,id2 (offered, never applied silently)
  const [incoming, setIncoming] = useState(() => {
    try {
      const raw = new URLSearchParams(window.location.search).get('fav')
      return raw == null ? null : cleanIds(raw.split(','))
    } catch {
      return null
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
      if (custom) localStorage.setItem('favoriteCourses', JSON.stringify(custom))
      else localStorage.removeItem('favoriteCourses')
    } catch {}
  }, [custom])

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('fav')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash)
    }
  }, [])

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

  // With Favorites on we ask the server for only the user's list (or the defaults until they customize).
  const favQuery = favoritesOnly ? (custom ? `&courses=${custom.join(',')}` : '&favorites=1') : ''

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    fetch(`/api/tee-times?date=${date}${favQuery}`, { signal: ctrl.signal })
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
  }, [date, favQuery])

  const defaultFavs = useMemo(() => (data?.courses ?? []).filter((c) => c.favorite).map((c) => c.id), [data])
  const favSet = useMemo(() => new Set(custom ?? defaultFavs), [custom, defaultFavs])
  const courseById = useMemo(() => new Map((data?.courses ?? []).map((c) => [c.id, c])), [data])
  const favCourses = useMemo(
    () => [...favSet].map((id) => courseById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
    [favSet, courseById],
  )

  // courses (not yet favorites) matching what was typed in the editor's "add a course" box
  const addMatches = useMemo(() => {
    const words = norm(favAdd).split(' ').filter(Boolean)
    if (!words.length) return []
    return (data?.courses ?? [])
      .filter((c) => !favSet.has(c.id) && words.every((w) => norm(`${c.name} ${c.city}`).includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [data, favAdd, favSet])

  // a shared list may name courses we don't have; only offer (and apply) the ones we do
  const incomingValid = useMemo(() => (incoming ?? []).filter((id) => courseById.has(id)), [incoming, courseById])

  const toggleFav = (id) =>
    setCustom((prev) => {
      const next = new Set(prev ?? defaultFavs)
      next.has(id) ? next.delete(id) : next.add(id)
      return [...next]
    })

  const shareFavorites = async () => {
    const url = `${window.location.origin}${window.location.pathname}?fav=${favCourses.map((c) => c.id).join(',')}`
    try {
      // a blocked or unfocused page can leave writeText pending forever, so don't wait on it for long
      await Promise.race([
        navigator.clipboard.writeText(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1500)),
      ])
      setShareNote('Link copied. Send it to a friend to share your list.')
    } catch {
      setShareNote(url) // clipboard blocked: show the link so it can be copied by hand
    }
  }

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
                    <span className="tag">Not in your favorites · tap ☆ to add</span>
                  ) : c.bookingUrl ? (
                    <a className="tag link" href={c.bookingUrl} target="_blank" rel="noreferrer">Not searchable here · book on their site ↗</a>
                  ) : (
                    <span className="tag">Not searchable · no online booking found</span>
                  )}
                  <Star on={favSet.has(c.id)} name={c.name} onClick={() => toggleFav(c.id)} />
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {incoming && data && incomingValid.length > 0 && (
        <div className="notice banner">
          <span>Someone shared a favorites list with you ({incomingValid.length} course{incomingValid.length === 1 ? '' : 's'}). Replace yours with it?</span>
          <span className="banner-actions">
            <button
              type="button"
              className="fav on"
              onClick={() => {
                setCustom(incomingValid)
                setFavoritesOnly(true)
                setIncoming(null)
              }}
            >
              Use it
            </button>
            <button type="button" className="fav" onClick={() => setIncoming(null)}>No thanks</button>
          </span>
        </div>
      )}

      <div className="favbar">
        <button type="button" className={favoritesOnly ? 'fav on' : 'fav'} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}>
          <span aria-hidden="true">{favoritesOnly ? '★' : '☆'}</span> Favorites only
        </button>
        {data && (
          <button type="button" className="link" onClick={() => setShowFavs((v) => !v)}>
            {showFavs ? 'Hide' : 'Edit'} my favorites ({favSet.size})
          </button>
        )}
        {favoritesOnly && data && favSet.size > 0 && (
          <small>
            Searching {data.courses.filter((c) => favSet.has(c.id) && c.searched).length} favorite courses
            {data.courses.some((c) => favSet.has(c.id) && !c.searchable) && (
              <>
                {' · can’t search: '}
                {data.courses
                  .filter((c) => favSet.has(c.id) && !c.searchable)
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

      {showFavs && data && (
        <section className="favpanel">
          <div className="favadd">
            <input
              type="search"
              value={favAdd}
              onChange={(e) => setFavAdd(e.target.value)}
              placeholder="Add a course to favorites (type a name or town)"
              aria-label="Add a course to favorites"
            />
            {favAdd.trim() && (
              <ul className="matches">
                {addMatches.length === 0 && (
                  <li className="none">
                    {favCourses.some((c) => norm(`${c.name} ${c.city}`).includes(norm(favAdd)))
                      ? 'Already in your favorites.'
                      : `No course matches “${favAdd.trim()}”.`}
                  </li>
                )}
                {addMatches.map((c) => (
                  <li key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>{c.city} · {c.driveMin} min · {c.searchable ? c.system : 'not searchable here'}</small>
                    </div>
                    <button type="button" className="add-btn" onClick={() => toggleFav(c.id)}>☆ Add</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {favCourses.length === 0 ? (
            <p className="sub">No favorites yet. Tap ☆ on any course in the search results or the course finder.</p>
          ) : (
            <ul className="favchips">
              {favCourses.map((c) => (
                <li key={c.id}>
                  <span>{c.name}</span>
                  <button type="button" aria-label={`Remove ${c.name} from favorites`} onClick={() => toggleFav(c.id)}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="bulk">
            <button type="button" className="link" onClick={shareFavorites} disabled={favCourses.length === 0}>Copy link to share my favorites</button>
            <button type="button" className="link" onClick={() => setCustom(null)} disabled={custom === null}>Reset to the default list</button>
          </div>
          {shareNote && (shareNote.startsWith('http') ? <input className="sharelink" readOnly value={shareNote} onFocus={(e) => e.target.select()} aria-label="Favorites link" /> : <p className="sub">{shareNote}</p>)}
          <p className="sub">Saved in this browser only. Use the link to move your list to another device.</p>
        </section>
      )}

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
              {favoritesOnly && favSet.size === 0
                ? 'Your favorites list is empty. Tap ☆ on a course, or turn Favorites off to see everything.'
                : data.teeTimes.length === 0 && !DAYS.includes(date)
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
                <Star on={favSet.has(t.courseId)} name={t.course} onClick={() => toggleFav(t.courseId)} />
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
