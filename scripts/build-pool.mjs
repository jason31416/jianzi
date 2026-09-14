#!/usr/bin/env node
/**
 * Build content/pool.json from raw Zhihu open-platform search responses.
 *
 * Usage: node scripts/build-pool.mjs [inputDir]   (default ../probe-raw)
 *
 * Entry bar (PRODUCT.md section 7): an author name must be present. Roughly 60% of
 * raw results have none, and a deck of anonymous cards cannot deliver "看见一个人".
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
const inputDir = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', 'probe-raw')
const avatarDir = path.join(import.meta.dirname, '..', 'public', 'avatars')
const outFile = path.join(import.meta.dirname, '..', 'content', 'pool.json')

const cleanTitle = (t) => t.replace(/\s*-\s*知乎\s*$/, '').trim()

async function saveAvatar(url) {
  const name = createHash('sha1').update(url).digest('hex').slice(0, 12) + '.jpg'
  const dest = path.join(avatarDir, name)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`avatar ${res.status}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return `/avatars/${name}`
}

const files = (await readdir(inputDir)).filter((f) => f.startsWith('s') && f.endsWith('.json'))
const items = []
for (const f of files) {
  const body = JSON.parse(await readFile(path.join(inputDir, f), 'utf8'))
  items.push(...(body?.Data?.Items ?? []))
}

await mkdir(avatarDir, { recursive: true })
const cards = []
const seenIds = new Set()
let skippedNoAuthor = 0

for (const it of items) {
  if (seenIds.has(it.ContentID)) continue
  seenIds.add(it.ContentID)

  const hasAuthor = Boolean(it.AuthorName) && !String(it.AuthorAvatar).includes(DEFAULT_AVATAR)
  if (!hasAuthor) {
    skippedNoAuthor++
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

await mkdir(path.dirname(outFile), { recursive: true })
await writeFile(outFile, JSON.stringify(cards, null, 2) + '\n')

console.log(`read    ${items.length} raw items from ${files.length} files`)
console.log(`skipped ${skippedNoAuthor} with no author`)
console.log(`wrote   ${cards.length} cards to content/pool.json`)
console.log(`pending ${cards.length} cards still need domain + reason`)
