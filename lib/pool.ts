import raw from '@/content/pool.json'
import type { Card } from './types'

/**
 * The whole deck. Static JSON bundled at build time — the frontend never calls a
 * Zhihu endpoint to render a card, so a judge's session costs zero API quota.
 */
export const pool = raw as Card[]
