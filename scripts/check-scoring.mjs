#!/usr/bin/env node
/**
 * Self-check for scripts/lib/score-reply.mjs. Plain node, no test framework.
 *
 *   node scripts/check-scoring.mjs
 *
 * Reply parsing is the one place where a model's formatting habits can silently
 * cost real cards: an id that goes missing is a card that stays unscored, and
 * unscored cards stay in the pool. These cases are the habits observed so far.
 */
import { parseScores, extractJson } from './lib/score-reply.mjs'

let failed = 0
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`)
  }
}

const IDS = ['100', '-200', '300']
const row = (id) => `{"id":"${id}","human":7,"evergreen":6,"accessible":8,"takeaway":7,"note":"还行"}`

console.log('reply parsing:')

const clean = parseScores(`{"results":[${IDS.map(row).join(',')}]}`, IDS)
check('clean batch of three', Object.keys(clean.scores).length === 3 && clean.missing.length === 0, clean)

const fenced = parseScores('```json\n{"results":[' + row('100') + ',' + row('-200') + ',' + row('300') + ']}\n```', IDS)
check('fenced code block', Object.keys(fenced.scores).length === 3, fenced)

const chatty = parseScores(`好的，我逐条打分：\n{"results":[${IDS.map(row).join(',')}]}\n以上是我的判断。`, IDS)
check('surrounded by prose', Object.keys(chatty.scores).length === 3, chatty)

const bare = parseScores(`[${IDS.map(row).join(',')}]`, IDS)
check('bare array instead of an object', Object.keys(bare.scores).length === 3, bare)

const short = parseScores(`{"results":[${row('100')},${row('300')}]}`, IDS)
check('missing id is reported, not invented', short.missing.length === 1 && short.missing[0] === '-200', short)

const strings = parseScores('{"results":[{"id":100,"human":"8","evergreen":"5","accessible":9,"takeaway":"7"}]}', ['100'])
check('numeric strings and unquoted ids accepted', strings.scores['100']?.human === 8 && strings.scores['100'].evergreen === 5, strings)

const clamped = parseScores('{"results":[{"id":"100","human":12,"evergreen":-3,"accessible":5,"takeaway":5}]}', ['100'])
check('out-of-range values clamped to 0..10', clamped.scores['100'].human === 10 && clamped.scores['100'].evergreen === 0, clamped)

const partial = parseScores('{"results":[{"id":"100","human":7}]}', ['100'])
check('row without the required scores is dropped', Object.keys(partial.scores).length === 0 && partial.missing.length === 1, partial)

const foreign = parseScores('{"results":[{"id":"999","human":8,"evergreen":8,"accessible":8,"takeaway":8}]}', ['100'])
check('unknown id is not filed under a real card', foreign.unknown.length === 1 && foreign.missing.length === 1, foreign)

const single = parseScores('{"human":9,"evergreen":7,"accessible":8,"takeaway":8,"note":"好"}', ['100'])
check('single card, reply without an id', single.scores['100']?.human === 9, single)

const truncated = parseScores('{"results":[{"id":"100","human":7,"evergreen":6,"accessible":8,"takeaway":7},{"id":"-200","human":', IDS)
check('truncated reply yields what it can, reports the rest', Object.keys(truncated.scores).length === 0 && truncated.missing.length === 3, truncated)

const nothing = parseScores('抱歉，我无法评分。', IDS)
check('no json at all', Object.keys(nothing.scores).length === 0 && nothing.missing.length === 3, nothing)

check('extractJson returns null on junk', extractJson('no json here') === null)

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
