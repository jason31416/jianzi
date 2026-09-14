#!/usr/bin/env node
/**
 * Build content/pool.json from raw Zhihu open-platform responses.
 *
 * Usage: node scripts/build-pool.mjs [inputDir]   (default ../pool-raw)
 *
 * Three layers, and only the last one costs anything.
 *
 *   1. Harvest gate — deterministic. Keep an item only when it is a zhihu.com
 *      page, carries a real timestamp, and has an author name that is not the
 *      anonymous placeholder. The deck cannot deliver "看见一个人" without a name,
 *      and roughly a third of raw items have none.
 *   2. Text features — deterministic, offline (scripts/lib/text-features.mjs).
 *      Counts the marks of hand-written Chinese: first-person narration, named
 *      relatives, concrete dates and amounts, dialogue, asides, self-correction,
 *      against the marks of machine prose: scaffold words, list numbering,
 *      buzzwords, news and tutorial register. Always on, because it is the only
 *      filter that exists when no model is configured, and because a model
 *      under-rates human-ness that lives in form rather than meaning. It drops
 *      nothing: a short or code-heavy excerpt is marked unmeasurable and passed
 *      on to the model, or kept when there is no model.
 *   3. Scoring — needs a model. Every surviving card answers the three questions
 *      from DESIGN.md section 9.5 (human voice, still true in three years,
 *      readable by an outsider, something to take away). Costs money, needs
 *      network, and is not reproducible run to run, so its output is cached in
 *      content/scores.json keyed by card id together with the model name and a
 *      hash of the prompt. Re-running the harvest never re-scores a card that
 *      already has a score.
 *
 * The final human score is 0.65 * model + 0.35 * features. A card the model
 * rejects outright (below 4) can be lifted by at most one point by its surface
 * features — first-person markers are trivially imitable by exactly the content
 * the model saw through.
 *
 * Credentials come from the environment, never from a file in the repo:
 *
 *   LLM_BASE_URL   OpenAI-compatible base, e.g. https://api.example.com/v1
 *   LLM_API_KEY    bearer token for that base
 *   LLM_MODEL      model id to send
 *
 * Optional, with defaults: POOL_MIN_HUMAN=6 POOL_MIN_ACCESSIBLE=6 POOL_MIN_TAKEAWAY=6
 * LLM_CONCURRENCY=4 (lower it for rate-limited or free endpoints) LLM_TIMEOUT_MS=60000
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
import { extractFeatures, combineHuman } from './lib/text-features.mjs'

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
  LLM_CONCURRENCY = '4',
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
let unmeasurable = 0

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

  // Layer two: text features. Free, deterministic, always on — it is the only
  // filter available when no model is configured. Nothing is dropped here; a
  // short or code-heavy excerpt is marked unmeasurable and decided later.
  const title = cleanTitle(it.Title ?? '')
  const excerpt = it.ContentText ?? ''
  const features = extractFeatures(title, excerpt)

  let avatar = ''
  try {
    avatar = await saveAvatar(it.AuthorAvatar)
  } catch (err) {
    console.warn(`  avatar failed for ${it.AuthorName}: ${err.message}`)
  }

  cards.push({
    id: it.ContentID,
    title,
    url: it.Url ?? '',
    contentType: it.ContentType === 'Article' ? 'Article' : 'Answer',
    excerpt,
    author: { name: it.AuthorName, badge: it.AuthorBadgeText ?? '', avatar },
    comments: (it.CommentInfoList ?? []).map((c) => c.Content).filter(Boolean),
    stats: {
      votes: it.VoteUpCount ?? 0,
      comments: it.CommentCount ?? 0,
      year: it.EditTime ? new Date(it.EditTime * 1000).getFullYear() : 0,
    },
    domain: '',
    reason: '',
    _features: features,
  })
}

// ---------------------------------------------------------------- scoring stage

const prompt = await readFile(promptFile, 'utf8')
const promptHash = createHash('sha1').update(prompt).digest('hex').slice(0, 12)
let scores = {}
try {
  const cached = JSON.parse(await readFile(scoreFile, 'utf8'))
  for (const [id, entry] of Object.entries(cached.scores ?? {})) {
    // v1 stored the model scores at the top level of the entry.
    scores[id] = entry.llm || typeof entry.human === 'number' ? { llm: entry.llm ?? entry, features: entry.features ?? null } : entry
  }
} catch {
  /* first run */
}

const canScore = Boolean(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL)
let scored = 0
let kept = cards

if (canScore) {
  const stale = cards.filter((c) => scores[c.id]?.llm?.promptHash !== promptHash || scores[c.id]?.llm?.model !== LLM_MODEL)
  console.log(`scoring ${stale.length} of ${cards.length} cards with ${LLM_MODEL} at concurrency ${LLM_CONCURRENCY} (${stale.length ? promptHash : 'all cached'})`)
  const results = await mapLimit(stale, Math.max(1, Number(LLM_CONCURRENCY)), (card) => scoreOne(prompt, card))
  results.forEach((r, i) => {
    const card = stale[i]
    if (!r) return
    scores[card.id] = {
      ...(scores[card.id] ?? {}),
      llm: { ...r, model: LLM_MODEL, promptHash, scoredAt: new Date().toISOString() },
    }
    scored++
  })
}

// Text features are recomputed every run, so they are written back per card
// whether or not the model was called.
for (const card of cards) {
  const { _features, ..._rest } = card
  scores[card.id] = { ...(scores[card.id] ?? {}), features: _features }
  scores[card.id].final = {
    human: combineHuman(scores[card.id].llm?.human, _features.ruleScore),
    rule: _features.ruleScore,
    llm: scores[card.id].llm?.human ?? null,
    evergreen: scores[card.id].llm?.evergreen ?? null,
    accessible: scores[card.id].llm?.accessible ?? null,
    takeaway: scores[card.id].llm?.takeaway ?? null,
  }
}
if (cards.length) await writeFile(scoreFile, JSON.stringify({ version: 2, model: LLM_MODEL ?? null, promptHash, scores }, null, 2) + '\n')

if (!POOL_KEEP_ALL) {
  const minHuman = Number(POOL_MIN_HUMAN)
  const minAccessible = Number(POOL_MIN_ACCESSIBLE)
  const minTakeaway = Number(POOL_MIN_TAKEAWAY)
  const before = cards.length
  let keptUnmeasurable = 0
  kept = cards.filter((c) => {
    const f = scores[c.id].final
    const feat = scores[c.id].features
    // A card the rule layer cannot read is decided by the model; with no model
    // there is no evidence against it, so it stays. Short and code-heavy
    // excerpts are not filtered out for being short or code-heavy.
    if (!canScore && !feat.measurable) {
      keptUnmeasurable++
      return true
    }
    if (f.human < minHuman) return false
    if (!canScore) return true // no model: the three questions are unmeasured, judge on human voice alone
    return f.accessible >= minAccessible && f.takeaway >= minTakeaway
  })
  unmeasurable = keptUnmeasurable
  console.log(
    canScore
      ? `filter (human>=${minHuman}, accessible>=${minAccessible}, takeaway>=${minTakeaway}): ${before - kept.length} dropped; human = 0.65*model + 0.35*features`
      : `filter (rule-only, human>=${minHuman}): ${before - kept.length} dropped, ${unmeasurable} kept unmeasurable; no model configured, so accessible/takeaway are not applied`,
  )
} else {
  console.warn('POOL_KEEP_ALL=1 — scoring and features still run, nothing is filtered out')
}

await mkdir(path.dirname(outFile), { recursive: true })
await writeFile(outFile, JSON.stringify(kept.map(({ _features, ...card }) => card), null, 2) + '\n')

console.log(`read    ${items.length} raw items from ${files.length} seed files`)
console.log(
  `dropped ${dropped.duplicate} duplicate, ${dropped.notZhihu} non-zhihu, ${dropped.noTimestamp} undated, ${dropped.anonymous} anonymous`,
)
console.log(`gated   ${cards.length} cards, ${scored} newly scored`)
console.log(`wrote   ${kept.length} cards to content/pool.json`)
console.log(`pending ${kept.length} cards still need domain + reason`)
