/**
 * Parsing the model's scoring reply. Pure, no I/O, so it can be checked directly.
 *
 * Batching means one reply carries many cards, which turns reply parsing into a
 * real contract instead of a formality: a reply that quietly loses half its ids
 * would silently leave those cards unscored, and unscored cards stay in the pool.
 * Hence the explicit `missing` list — the caller retries those on their own.
 */

const NUM = (v) => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const clampScore = (n) => (n === null ? null : Math.max(0, Math.min(10, Math.round(n))))

/** Pull the JSON payload out of a reply that may be fenced, prefaced, or both. */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const arrayStart = body.indexOf('[')
  const objectStart = body.indexOf('{')
  const starts = [arrayStart, objectStart].filter((i) => i >= 0)
  if (!starts.length) return null
  const start = Math.min(...starts)
  const open = body[start]
  const close = open === '[' ? ']' : '}'
  const end = body.lastIndexOf(close)
  if (end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload?.scores)) return payload.scores
  // A single card, scored on its own.
  if (payload && typeof payload === 'object' && ('human' in payload || 'takeaway' in payload)) return [payload]
  return []
}

function normalize(row, fallbackId) {
  const id = row?.id !== undefined && row?.id !== null && row?.id !== '' ? String(row.id) : fallbackId
  const human = clampScore(NUM(row?.human))
  const accessible = clampScore(NUM(row?.accessible))
  const takeaway = clampScore(NUM(row?.takeaway))
  const evergreen = clampScore(NUM(row?.evergreen))
  if (human === null || accessible === null || takeaway === null) return null
  return { id, human, evergreen, accessible, takeaway, note: typeof row?.note === 'string' ? row.note.slice(0, 200) : '' }
}

/**
 * @param {string} text raw reply
 * @param {string[]} ids ids that were sent, in order
 * @returns {{scores: Record<string, object>, missing: string[], unknown: string[]}}
 */
export function parseScores(text, ids) {
  const wanted = ids.map(String)
  const singles = wanted.length === 1
  const payload = extractJson(text)
  const rows = rowsOf(payload)
  const scores = {}
  const unknown = []
  for (const [i, row] of rows.entries()) {
    // With a single id and a reply that carries no id, the row obviously belongs to it.
    const normalized = normalize(row, singles && !row?.id ? wanted[0] : undefined)
    if (!normalized) continue
    if (!wanted.includes(normalized.id)) {
      unknown.push(String(normalized.id ?? i))
      continue
    }
    scores[normalized.id] = normalized
  }
  return { scores, missing: wanted.filter((id) => !scores[id]), unknown }
}
