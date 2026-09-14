import type { Card } from './types'

/** What the browser remembers. Card ids only — nothing leaves localStorage. */
export type Prefs = {
  liked: string[]
  disliked: string[]
}

export const emptyPrefs: Prefs = { liked: [], disliked: [] }

/**
 * Order the deck. Pure — no React, no Next, no browser APIs, so it stays runnable
 * on its own.
 *
 * The rule runs the usual recommendation logic backwards: domains the reader has
 * already reacted to sink, domains they have never touched rise. Liking three
 * technology cards is a reason to show them forestry, not more technology.
 */
export function orderDeck(cards: Card[], prefs: Prefs): Card[] {
  const seen = new Set([...prefs.liked, ...prefs.disliked])
  const touchedDomains = new Set(
    cards.filter((c) => seen.has(c.id)).map((c) => c.domain)
  )

  return cards
    .filter((c) => !seen.has(c.id))
    .map((card, i) => ({ card, i }))
    .sort((a, b) => {
      const aFresh = a.card.domain && !touchedDomains.has(a.card.domain) ? 0 : 1
      const bFresh = b.card.domain && !touchedDomains.has(b.card.domain) ? 0 : 1
      return aFresh - bFresh || a.i - b.i
    })
    .map(({ card }) => card)
}
