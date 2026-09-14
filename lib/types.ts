/** One card in the deck. Generated offline into content/pool.json, read-only at runtime. */
export type Card = {
  /** Zhihu ContentID. Stable, used as the React key and the preference key. */
  id: string
  /** Question title, with the trailing " - 知乎" stripped. */
  title: string
  /** Link to the original on zhihu.com. The card's final destination. */
  url: string
  contentType: 'Answer' | 'Article'
  /** ContentText verbatim — the opening of the answer, ~1000 chars. Never edited. */
  excerpt: string
  /** null means the API gave us no author. Render 署名不详, never a blank row. */
  author: Author | null
  /** Featured comments, Content only (no author, no timestamp). Often empty. */
  comments: string[]
  stats: Stats
  /**
   * Subject area, used for the stamp and for reverse recommendation.
   * Empty until the pool is curated — see scripts/build-pool.mjs.
   */
  domain: string
  /**
   * The one line saying why this card was picked. The product's own voice,
   * the only handwritten text on screen. Empty until curated.
   * Never a summary of the answer — see DESIGN.md.
   */
  reason: string
}

export type Author = {
  name: string
  /** Zhihu credential line. High signal but present on only ~14% of raw results. */
  badge: string
  /** Local path under /avatars, downloaded at pool-build time to dodge hotlink blocks. */
  avatar: string
}

export type Stats = {
  votes: number
  comments: number
  /** Year the answer was last edited. */
  year: number
}
