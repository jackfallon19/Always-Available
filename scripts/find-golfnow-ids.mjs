// Adds golfnow_facility_id to courses.json by matching each course against GolfNow's search autocomplete
// (name query; a hit is accepted only if its name shares at least half our name's words AND it is within MAX_KM).
//   node scripts/find-golfnow-ids.mjs          # fill in missing ids
//   node scripts/find-golfnow-ids.mjs --redo   # re-match everything
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../courses.json', import.meta.url)
const MAX_KM = 8 // census coordinates are only approximate, so the name has to match too
const redo = process.argv.includes('--redo')
// hand-checked matches the automatic name matching can't make (verified by name + distance)
const OVERRIDES = { 'crane-s-landing-marriott-lincolnshire-lincolnshire': 974 } // Crane's Landing -> Cranes Landing Golf Club
const courses = JSON.parse(readFileSync(FILE))

const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}
const words = (s) =>
  (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !['golf', 'course', 'club', 'the', 'gc', 'cc', 'country', 'gcc'].includes(w))
const NOT_A_COURSE = /golftec|simulator|indoor|foundation|lounge|topgolf|driving range|academy|mini/i
// short names must match fully; longer ones may miss a word or two
const needed = (n) => (n <= 2 ? n : Math.ceil(n * 0.66))

async function lookup(q, c) {
  const r = await fetch('https://www.golfnow.com/api/autocomplete/geolookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ searchKey: q, take: 20, skip: 0, lat: c.lat, lng: c.lon }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).hits ?? []
}

function best(hits, c) {
  const mine = new Set(words(c.name.replace(/\(.*?\)/g, '')))
  return hits
    .filter((h) => h.type === 'course' && h.contextInformation?.ids?.golfFacilityID && h.geo && !NOT_A_COURSE.test(h.name))
    .map((h) => ({
      h,
      dist: km({ lat: c.lat, lon: c.lon }, { lat: h.geo.lat, lon: h.geo.lon }),
      overlap: words(h.name).filter((w) => mine.has(w)).length,
    }))
    .filter((x) => x.dist <= MAX_KM && x.overlap >= Math.max(1, needed(mine.size)))
    .sort((a, b) => b.overlap - a.overlap || a.dist - b.dist)[0]
}

const missed = []
for (const c of courses) {
  if (redo) delete c.golfnow_facility_id
  if (OVERRIDES[c.id]) c.golfnow_facility_id = OVERRIDES[c.id]
  if (c.golfnow_facility_id) continue
  const base = c.name.replace(/\(.*?\)/g, '').replace(/[–—]/g, ' ').trim()
  let m
  for (const q of [base, `${base} ${c.city}`, words(base).join(' ')]) {
    try {
      m = best(await lookup(q, c), c)
    } catch (e) {
      console.log('!!', c.name, e.message)
    }
    await new Promise((r) => setTimeout(r, 250))
    if (m) break
  }
  if (m) {
    c.golfnow_facility_id = Number(m.h.contextInformation.ids.golfFacilityID)
    console.log(`ok  ${c.name.padEnd(34)} -> ${m.h.name} (${c.golfnow_facility_id}) ${m.dist.toFixed(2)}km`)
  } else {
    missed.push(c.name)
    console.log(`--  ${c.name}`)
  }
}
writeFileSync(FILE, JSON.stringify(courses, null, 2))
console.log(`\nmatched ${courses.filter((c) => c.golfnow_facility_id).length}/${courses.length}; unmatched: ${missed.length}`)
