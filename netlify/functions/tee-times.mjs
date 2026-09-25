// Netlify Function: GET /api/tee-times (see lib/search.js for the parameters)
import { searchTeeTimes } from '../../lib/search.js'

export default async (req) => {
  const { status, body, cache } = await searchTeeTimes(new URL(req.url).searchParams)
  return Response.json(body, { status, headers: { 'cache-control': cache } })
}

export const config = { path: '/api/tee-times' }
