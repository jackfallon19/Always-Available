// Vercel Function: GET /api/tee-times (see lib/search.js for the parameters)
import { searchTeeTimes } from '../lib/search.js'

export default async function handler(req, res) {
  const { status, body, cache } = await searchTeeTimes(new URL(req.url, 'http://localhost').searchParams)
  res.setHeader('cache-control', cache)
  res.status(status).json(body)
}
