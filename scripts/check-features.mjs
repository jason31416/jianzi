#!/usr/bin/env node
/**
 * Self-check for scripts/lib/text-features.mjs. Plain node, no test framework.
 *
 *   node scripts/check-features.mjs
 *
 * Asserts the contract the pool builder relies on: hand-written prose scores
 * high, SEO scaffolding and code score low, code-dominant and tiny excerpts are
 * hard-dropped, and the combination never lets features rescue a card the model
 * rejected outright.
 */
import { extractFeatures, combineHuman } from './lib/text-features.mjs'

let failed = 0
const check = (name, actual, ok) => {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name} -> ${JSON.stringify(actual)}`)
  }
}

const HUMAN = `我奶奶走的那年冬天，我还在北京。那天晚上我妈打电话说，你奶奶不行了。
我买了第二天最早的一班高铁，坐了十一个小时，到家的时候她已经走了。奶奶生前最后
一句话是问我什么时候回来，我妈说，他过年就回来了。其实那一年我本来不打算回家的。

后来我翻她的柜子，找到我小学时候的作业本，还有一包我五年级掉的门牙，用红纸包着。
我妈说，她一直收着，说等我以后有孩子了给孩子看。`

const SEO = `大语言模型是不是发展到头了？首先，我们需要明确当前的技术阶段，理解清楚
预训练与后训练的边界在哪里。其次，要从算力、数据、算法三个方面逐一分析，缺一不可。
再次，还要考虑工程化落地的成本问题，这里的细节非常关键。综上所述，模型规模仍然是
核心变量，规模效应在可预见的未来依然成立。值得一提的是，范式转移正在发生，整个行业
的底层逻辑已经发生变化，具有重要的参考价值。对于从业者而言，需要深刻理解这一趋势，
并且及时调整自己的知识结构。最后，希望对大家有所帮助，也希望每个人都能抓住机会。`

const CODE = `from functools import wraps
import time

def retry(max_attempts=3, delay=1):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if attempt == max_attempts: raise
                    time.sleep(delay)
        return wrapper
    return decorator`

const TINY = '三个字，好看。'

console.log('text features:')
const human = extractFeatures('我奶奶', HUMAN)
const seo = extractFeatures('大语言模型是不是发展到头了？', SEO)
const code = extractFeatures('Python 装饰器', CODE)
const tiny = extractFeatures('短', TINY)

check('human ruleScore >= 7', human.ruleScore, human.ruleScore >= 7)
check('human not dropped', human.hardDrop, human.hardDrop === null)
check('human detected first person + named relation', human.positive, human.positive.first_person_narration > 0 && human.positive.named_relation > 0)
check('seo ruleScore <= 4', seo.ruleScore, seo.ruleScore <= 4)
check('seo flagged scaffolding', seo.negative, (seo.negative.scaffold ?? 0) >= 2)
check('code hard-dropped', code.hardDrop, code.hardDrop === 'code-dominant')
check('tiny hard-dropped', tiny.hardDrop, tiny.hardDrop === 'too-short')
check('human beats seo', [human.ruleScore, seo.ruleScore], human.ruleScore > seo.ruleScore)

console.log('combination:')
check('no model -> features stand alone', combineHuman(undefined, 7), combineHuman(undefined, 7) === 7)
check('strong form lifts a strong model score', [8, 10], combineHuman(8, 10) >= 9)
check('features cannot rescue a rejected card', [2, 10], combineHuman(2, 10) <= 4)
check('weak form drags a borderline score down', [7, 0], combineHuman(7, 0) <= 5)

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
