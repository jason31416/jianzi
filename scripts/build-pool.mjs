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
 *   3. Scoring — needs a model. Cards are sent LLM_BATCH_SIZE at a time and each
 *      answers the three questions from DESIGN.md section 9.5 (human voice, still
 *      true in three years, readable by an outsider, something to take away).
 *      Batching is not only cheaper: scored side by side against two fixed
 *      anchors in the prompt, the model keeps its scale instead of drifting with
 *      whatever it saw last. Costs money, needs network, and is not reproducible
 *      run to run, so its output is cached in content/scores.json keyed by card
 *      id together with the model name and a hash of the prompt. Re-running the
 *      harvest never re-scores a card that already has a score.
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
 * LLM_BATCH_SIZE=6 cards per call, LLM_EXCERPT_CHARS=1200 per card,
 * LLM_CONCURRENCY=4 calls at a time (lower it for rate-limited endpoints),
 * LLM_TIMEOUT_MS=60000
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
import { parseScores } from './lib/score-reply.mjs'

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
  LLM_TIMEOUT_MS = '180000',
  LLM_CONCURRENCY = '4',
  LLM_BATCH_SIZE = '6',
  LLM_EXCERPT_CHARS = '1200',
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

/** One HTTP call. Returns the assistant text, or null when it fails twice. */
async function callModel(prompt, userContent, what = '') {
  const body = {
    model: LLM_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
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
      if (!text) throw new Error('empty reply')
      return text
    } catch (err) {
      if (attempt === 1) {
        console.warn(`  call failed${what ? ` for ${what}` : ''}: ${err.message}`)
        return null
      }
      await sleep(1000)
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

const renderBatch = (cards) =>
  cards
    .map((c) => `### id: ${c.id}\n标题：${c.title}\n\n正文开头：\n${c.excerpt.slice(0, Number(LLM_EXCERPT_CHARS))}`)
    .join('\n\n---\n\n')

/** Score one batch. Returns the parsed scores keyed by card id; ids may be missing. */
async function scoreCards(prompt, cards) {
  const text = await callModel(prompt, renderBatch(cards), cards.length === 1 ? cards[0].id : `${cards.length} cards`)
  if (!text) return {}
  const { scores, missing, unknown } = parseScores(text, cards.map((c) => c.id))
  if (unknown.length) console.warn(`  reply carried ${unknown.length} unknown id(s)`)
  if (missing.length) console.warn(`  reply missing ${missing.length}/${cards.length} id(s)`)
  return scores
}

const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size))

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
  scores = JSON.parse(await readFile(scoreFile, 'utf8')).scores ?? {}
} catch {
  /* first run */
}

const canScore = Boolean(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL)
let scored = 0
let kept = cards

const persist = async () =>
  writeFile(scoreFile, JSON.stringify({ version: 2, model: LLM_MODEL ?? null, promptHash, scores }, null, 2) + '\n')

// One place computes the blended verdict, so the pre-score pass and the
// post-score update can never disagree about which fields exist.
const finalize = (card) => {
  const entry = scores[card.id]
  entry.final = {
    human: combineHuman(entry.llm?.human, entry.features.ruleScore),
    rule: entry.features.ruleScore,
    llm: entry.llm?.human ?? null,
    evergreen: entry.llm?.evergreen ?? null,
    accessible: entry.llm?.accessible ?? null,
    takeaway: entry.llm?.takeaway ?? null,
  }
}

// Text features are recomputed every run, so they are attached to every card up
// front — before any model call, and before anything is written to disk.
for (const card of cards) {
  const { _features } = card
  scores[card.id] = { ...(scores[card.id] ?? {}), features: _features }
  finalize(card)
}

if (canScore) {
  const stale = cards.filter((c) => scores[c.id]?.llm?.promptHash !== promptHash || scores[c.id]?.llm?.model !== LLM_MODEL)
  const batchSize = Math.max(1, Number(LLM_BATCH_SIZE))
  const batches = chunk(stale, batchSize)
  console.log(
    `scoring ${stale.length} of ${cards.length} cards in ${batches.length} batches of ${batchSize}, ${LLM_CONCURRENCY} at a time, with ${LLM_MODEL} (${stale.length ? promptHash : 'all cached'})`,
  )
  let done = 0
  await mapLimit(batches, Math.max(1, Number(LLM_CONCURRENCY)), async (batch) => {
    const started = Date.now()
    const got = await scoreCards(prompt, batch)
    // A batch that comes back short is retried one card at a time: replies get
    // truncated, and losing five good cards because one id is absent is worse
    // than five extra calls.
    const missing = batch.filter((c) => !got[c.id])
    if (missing.length && batch.length > 1) {
      console.log(`  batch short by ${missing.length}, retrying those alone`)
      for (const card of missing) Object.assign(got, await scoreCards(prompt, [card]))
    }
    for (const card of batch) {
      const r = got[card.id]
      done++
      if (r) {
        scores[card.id] = { ...(scores[card.id] ?? {}), llm: { ...r, model: LLM_MODEL, promptHash, scoredAt: new Date().toISOString() } }
        finalize(card)
        scored++
      }
    }
    // Persist as we go: a scored pool is expensive, a half-hour silent run that
    // dies at minute twenty-nine is not worth the discount.
    await persist()
    console.log(`  scored ${done}/${stale.length} (${scored} ok, last batch ${((Date.now() - started) / 1000).toFixed(1)}s)`)
  })
}

if (cards.length) await persist()

if (!POOL_KEEP_ALL) {
  const minHuman = Number(POOL_MIN_HUMAN)
  const minAccessible = Number(POOL_MIN_ACCESSIBLE)
  const minTakeaway = Number(POOL_MIN_TAKEAWAY)
  const before = cards.length
  // A card the rule layer cannot read is decided by the model; with no model
  // there is no evidence against it, so it stays. Short and code-heavy excerpts
  // are not filtered out for being short or code-heavy.
  const verdict = (c) => {
    const f = scores[c.id].final
    if (!canScore) {
      if (!scores[c.id].features.measurable) return { keep: true, unmeasurable: true }
      return { keep: f.human >= minHuman, unmeasurable: false }
    }
    return { keep: f.human >= minHuman && f.accessible >= minAccessible && f.takeaway >= minTakeaway, unmeasurable: false }
  }
  const judged = cards.map((c) => ({ card: c, ...verdict(c) }))
  kept = judged.filter((j) => j.keep).map((j) => j.card)
  unmeasurable = judged.filter((j) => j.unmeasurable).length
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
