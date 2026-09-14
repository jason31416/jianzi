#!/usr/bin/env node
/**
 * Build content/pool.json from raw Zhihu open-platform responses.
 *
 * Usage: node scripts/build-pool.mjs [inputDir]   (default ../pool-raw)
 *
 * Two stages, and only the first one is free.
 *
 *   1. Harvest gate — deterministic. Keep an item only when it is a zhihu.com
 *      page, carries a real timestamp, and has an author name that is not the
 *      anonymous placeholder. The deck cannot deliver "看见一个人" without a name,
 *      and roughly a third of raw items have none.
 *   2. Scoring — needs a model. Every surviving card is scored on the three
 *      questions from DESIGN.md section 9.5 (human voice, still true in three
 *      years, readable by an outsider, something to take away). This stage costs
 *      money, needs network, and is not reproducible run to run, so its output is
 *      cached in content/scores.json keyed by card id together with the model
 *      name and a hash of the prompt. Re-running the harvest never re-scores a
 *      card that already has a score.
 *
 * Credentials come from the environment, never from a file in the repo:
 *
 *   LLM_BASE_URL   OpenAI-compatible base, e.g. https://api.example.com/v1
 *   LLM_API_KEY    bearer token for that base
 *   LLM_MODEL      model id to send
 *
 * Optional, with defaults: POOL_MIN_HUMAN=6 POOL_MIN_ACCESSIBLE=6 POOL_MIN_TAKEAWAY=6
 * Set POOL_KEEP_ALL=1 to score everything and keep every card regardless of score.
 *
 * Without LLM_BASE_URL / LLM_API_KEY the script still writes pool.json — the whole
 * gated pool, unscored — and says so. Scoring degrades to a no-op, never to an error.
 *
 * Avatars are downloaded to public/avatars because zhimg.com may refuse hotlinks
 * from our domain, and that failure is silent (DESIGN.md section 9).
 *
 * domain and reason are left empty on purpose. They are the two fields the product
 * writes rather than reads, and both are filled by a curation pass.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const DEFAULT_AVATAR = 'da8e974dc' // Zhihu's anonymous placeholder
const inputDir = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', 'pool-raw')
const avatarDir = path.join(import.meta.dirname, '..', 'public', 'avatars')
const outFile = path.join(import.meta.dirname, '..', 'content', 'pool.json')
const scoreFile = path.join(import.meta.dirname, '..', 'content', 'scores.json')
const promptFile = path.join(import.meta.dirname, 'prompts', 'score-card.md')

const {
  LLM_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL,
  LLM_TIMEOUT_MS = '60000',
  POOL_MIN_HUMAN = '6',
  POOL_MIN_ACCESSIBLE = '6',
  POOL_MIN_TAKEAWAY = '6',
  POOL_KEEP_ALL = '',
} = process.env

const cleanTitle = (t) => t.replace(/\s*-\s*知乎\s*$/, '').trim()
const host = (u) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}

// Seed files only: seed01.json, seed02.json, plus the legacy s01_kankan1.json probe names.
// Anything else in the directory (quota dumps, scores, summaries) is not content.
const isSeedFile = (f) => /^(seed\d+|s\d+_\w+)\.json$/.test(f)

async function saveAvatar(url) {
  const name = createHash('sha1').update(url).digest('hex').slice(0, 12) + '.jpg'
  const dest = path.join(avatarDir, name)
  try {
    await readFile(dest)
    return `/avatars/${name}` // already downloaded
  } catch {
    /* not cached yet */
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`avatar ${res.status}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return `/avatars/${name}`
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One scoring call. Returns null when the model refuses to give parseable JSON twice. */
async function scoreOne(prompt, card) {
  const body = {
    model: LLM_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `题目：${card.title}\n\n正文开头：\n${card.excerpt.slice(0, 2000)}` },
    ],
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), Number(LLM_TIMEOUT_MS))
    try {
      const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const json = await res.json()
      const text = json?.choices?.[0]?.message?.content ?? ''
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('no json in reply')
      const parsed = JSON.parse(match[0])
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const scores = {
        human: num(parsed.human),
        accessible: num(parsed.accessible),
        takeaway: num(parsed.takeaway),
        note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : '',
      }
      if (scores.human === null || scores.accessible === null || scores.takeaway === null) throw new Error('missing fields')
      return scores
    } catch (err) {
      if (attempt === 1) {
        console.warn(`  score failed for ${card.id}: ${err.message}`)
        return null
      }
      await sleep(1000)
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

const files = (await readdir(inputDir)).filter(isSeedFile).sort()
const items = []
for (const f of files) {
  const body = JSON.parse(await readFile(path.join(inputDir, f), 'utf8'))
  items.push(...(body?.Data?.Items ?? []))
}

await mkdir(avatarDir, { recursive: true })
const seenIds = new Set()
const cards = []
const dropped = { duplicate: 0, notZhihu: 0, noTimestamp: 0, anonymous: 0 }

for (const it of items) {
  if (seenIds.has(it.ContentID)) {
    dropped.duplicate++
    continue
  }
  seenIds.add(it.ContentID)

  if (!['www.zhihu.com', 'zhuanlan.zhihu.com'].includes(host(it.Url))) {
    dropped.notZhihu++
    continue
  }
  if (!it.EditTime) {
    dropped.noTimestamp++
    continue
  }
  if (!it.AuthorName || String(it.AuthorAvatar).includes(DEFAULT_AVATAR)) {
    dropped.anonymous++
    continue
  }

  let avatar = ''
  try {
    avatar = await saveAvatar(it.AuthorAvatar)
  } catch (err) {
    console.warn(`  avatar failed for ${it.AuthorName}: ${err.message}`)
  }

  cards.push({
    id: it.ContentID,
    title: cleanTitle(it.Title ?? ''),
    url: it.Url ?? '',
    contentType: it.ContentType === 'Article' ? 'Article' : 'Answer',
    excerpt: it.ContentText ?? '',
    author: { name: it.AuthorName, badge: it.AuthorBadgeText ?? '', avatar },
    comments: (it.CommentInfoList ?? []).map((c) => c.Content).filter(Boolean),
    stats: {
      votes: it.VoteUpCount ?? 0,
      comments: it.CommentCount ?? 0,
      year: it.EditTime ? new Date(it.EditTime * 1000).getFullYear() : 0,
    },
    domain: '',
    reason: '',
  })
}

// ---------------------------------------------------------------- scoring stage

const prompt = await readFile(promptFile, 'utf8')
const promptHash = createHash('sha1').update(prompt).digest('hex').slice(0, 12)
let scores = {}
try {
  scores = JSON.parse(await readFile(scoreFile, 'utf8')).scores ?? {}
} catch {
  /* first run */
}

const canScore = Boolean(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL)
let scored = 0
let kept = cards

if (canScore) {
  const stale = cards.filter((c) => scores[c.id]?.promptHash !== promptHash || scores[c.id]?.model !== LLM_MODEL)
  console.log(`scoring ${stale.length} of ${cards.length} cards with ${LLM_MODEL} (${stale.length ? promptHash : 'all cached'})`)
  const results = await mapLimit(stale, 4, (card) => scoreOne(prompt, card))
  results.forEach((r, i) => {
    const card = stale[i]
    if (!r) return
    scores[card.id] = { ...r, model: LLM_MODEL, promptHash, scoredAt: new Date().toISOString() }
    scored++
  })
  await writeFile(scoreFile, JSON.stringify({ model: LLM_MODEL, promptHash, scores }, null, 2) + '\n')

  if (!POOL_KEEP_ALL) {
    const minHuman = Number(POOL_MIN_HUMAN)
    const minAccessible = Number(POOL_MIN_ACCESSIBLE)
    const minTakeaway = Number(POOL_MIN_TAKEAWAY)
    const before = cards.length
    kept = cards.filter((c) => {
      const s = scores[c.id]
      if (!s) return true // unscored: no evidence against it, keep it
      return s.human >= minHuman && s.accessible >= minAccessible && s.takeaway >= minTakeaway
    })
    console.log(`score filter (human>=${minHuman}, accessible>=${minAccessible}, takeaway>=${minTakeaway}): ${before - kept.length} dropped`)
  }
} else if (cards.length) {
  console.warn('LLM_BASE_URL / LLM_API_KEY / LLM_MODEL not set — pool.json written unscored, no filtering')
}

await mkdir(path.dirname(outFile), { recursive: true })
await writeFile(outFile, JSON.stringify(kept, null, 2) + '\n')

console.log(`read    ${items.length} raw items from ${files.length} seed files`)
console.log(`dropped ${dropped.duplicate} duplicate, ${dropped.notZhihu} non-zhihu, ${dropped.noTimestamp} undated, ${dropped.anonymous} anonymous`)
console.log(`gated   ${cards.length} cards, ${scored} newly scored`)
console.log(`wrote   ${kept.length} cards to content/pool.json`)
console.log(`pending ${kept.length} cards still need domain + reason`)
