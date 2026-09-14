/**
 * Deterministic text features. No network, no model, no dependencies.
 *
 * This is the layer that runs before — and independently of — the LLM scorer.
 * It exists for three reasons:
 *
 *   1. A model reads meaning; it under-rates writing whose human-ness lives in
 *      *form*: a dated anecdote, a named relative, a self-correction, a line of
 *      dialogue. Those are countable, so count them.
 *   2. The pool has to stay buildable without a key. With no LLM configured the
 *      text features are the only filter, and a rule filter beats no filter.
 *   3. Every score has to be explainable. The hits carry the matched strings, so
 *      a human can see why a card scored where it did.
 *
 * Nothing is dropped here. A short excerpt and a code-heavy excerpt are marked
 * unmeasurable instead: the rule layer has nothing to judge, which is not the
 * same as judging against. Those cards are decided by the model, or kept as-is
 * when there is no model.
 *
 * ruleScore is 0-10 and deliberately coarse: 5 means "nothing either way".
 */

const POSITIVE = [
  ['first_person_narration', /我(?:当时|后来|那时|那会儿|记得|觉得|以为|发现|第一次|一直|本来|终于|从来|真的|才知道|没想到)/g, 2],
  ['first_person', /我/g, 0.4],
  ['named_relation', /我(?:妈|爸爸|爸|母亲|爷爷|奶奶|外婆|外公|老婆|媳妇|老公|儿子|女儿|哥|姐|弟|妹|舅|叔|姨|姑|室友|同事|领导|导师|老板|朋友|同学|表姐|表哥)/g, 2],
  ['concrete_date', /(?:\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|去年|前年|上个?月|上周|那天|第二天|大二|大三|小学|初中|高中)/g, 1.2],
  ['concrete_number', /\d+\s*(?:块|元|万|亿|岁|次|遍|天|个月|年|公里|斤|米|楼|人|个|%|℃)/g, 1],
  ['money', /\d+(?:\.\d+)?\s*(?:块|元|万|w|W|k|K)(?![a-zA-Z])/g, 1.5],
  ['colloquial', /(?:说实话|其实吧|讲真|不吹不黑|说白了|反正|倒是|罢了|嘛|呗|哈|哈哈|呵呵)/g, 1],
  ['slang', /(?:破防|摆烂|内卷|真香|绝了|离谱|逆天|抽象|emo|蚌埠|整活|牛马|笑死|233|谢邀|泻药)/g, 1.5],
  ['dialogue', /[「“"][^」”"\n]{2,40}[」”"]/g, 1],
  ['aside', /（[^）\n]{1,30}）|\([^)\n]{1,30}\)/g, 0.8],
  ['hesitation', /(?:可能|大概|也许|记不清|不确定|说不定|我也说不好|印象里)/g, 0.6],
  ['self_correction', /(?:其实|不过|但后来|话又说回来|说起来|回头看)/g, 0.5],
]

const NEGATIVE = [
  ['scaffold', /(?:首先|其次|再次|最后|综上所述|总而言之|总的来说|总之|由此可见|归根结底)/g, 1.5],
  ['scaffold_pair', /首先[^。\n]{0,120}其次/s, 3],
  ['numbered_list', /(?:^|\n)\s*(?:\d+[.、)]|[一二三四五六七八九十]+[、.])/g, 1.5],
  ['buzzword', /(?:赋能|闭环|抓手|颗粒度|底层逻辑|范式|生态位|心智模型|协同效应|价值锚点)/g, 2],
  ['empty_intensifier', /(?:深刻地?[^。\n]{0,4}(?:影响|改变)|极大地?[^。\n]{0,4}(?:提升|改善)|起到了[^。\n]{0,10}作用|具有重要(?:意义|价值))/g, 2],
  ['news_style', /(?:每日|资讯|速览|盘点|汇总|据[^。\n]{0,12}报道|第一时间|截至目前|日前)/g, 2],
  ['tutorial_style', /(?:第一步|第二步|步骤|安装|配置|代码如下|示例代码|import\s|from\s+\w+\s+import|def\s+\w+\(|function\s+\w+\(|<\/?[a-z]+>)/g, 2],
  ['formula_style', /(?:\\frac|\\sum|\\begin\{|\$\$|\^\{|_\{|\\mathbf)/g, 2],
  ['marketing', /(?:靠谱|推荐大家|私信|加我微信|免费咨询|限时|扫码|点击下方|关注公众号|欢迎大家)/g, 2.5],
  ['listener_title', /(?:\d+\s*[个样条种款]|这\d+[个样条种款]|清单|必看|必读|建议收藏|别再|智商税)/g, 2.5],
  ['summary_ending', /(?:希望对(?:你|大家)有(?:所)?帮助|以上就是|愿你|共勉|与君共勉)/g, 2],
]

/** Latin/代码字符占比，用来识别代码为主的正文。`def foo(x):` 这类内容不该出现在卡片上。 */
function codeRatio(text) {
  const code = (text.match(/[a-zA-Z_{}()[\];=<>$\\/#]/g) ?? []).length
  return text.length ? code / text.length : 0
}



/**
 * @param {string} title
 * @param {string} excerpt
 * @returns {{chars:number, ruleScore:number, measurable:boolean, flags:object, positive:object, negative:object, hits:Array}}
 */
export function extractFeatures(title, excerpt) {
  const text = `${title ?? ''}\n${excerpt ?? ''}`
  const chars = text.length
  const code = codeRatio(excerpt ?? '')

  // Two shapes the rule layer cannot judge, but must not throw away either: a
  // very short excerpt has no room to show its marks, and one that is mostly
  // code says nothing about how a person writes. They are reported as
  // unmeasurable and left to the model, or kept when there is no model.
  const flags = { short: chars < 150, codeHeavy: code > 0.15 }
  const measurable = !flags.short && !flags.codeHeavy

  if (!measurable) {
    return { chars, codeRatio: +code.toFixed(3), ruleScore: 5, measurable, flags, positive: {}, negative: {}, hits: [] }
  }

  const collect = (table, polarity) => {
    const counts = {}
    const hits = []
    for (const [name, re] of table) {
      const m = text.match(re)
      if (!m?.length) continue
      counts[name] = m.length
      hits.push({ polarity, name, count: m.length, sample: (m[0].length > 24 ? m[0].slice(0, 24) + '…' : m[0]).replace(/\s+/g, ' ') })
    }
    return { counts, hits }
  }

  const pos = collect(POSITIVE, 'positive')
  const neg = collect(NEGATIVE, 'negative')

  // Score on *breadth*, not on volume. An earlier count-weighted version put 142
  // of 214 real cards on a perfect 10, which tells a reader nothing. How many
  // different human markers appear separates prose from prose; how many times
  // the same one appears mostly measures length, which is fixed here.
  const posFired = Object.keys(pos.counts).length
  const negFired = Object.keys(neg.counts).length
  let score = 5
  score += 0.9 * Math.min(posFired, 5)
  score -= 1.3 * Math.min(negFired, 4)
  // A dated personal account — a named person plus a concrete time — is the
  // single strongest mark of a human author.
  if (pos.counts.named_relation && pos.counts.concrete_date) score += 0.5
  // Two veto signals: a listicle title and marketing copy. Either one is enough
  // to disqualify a card for this product regardless of everything else.
  if (neg.counts.listener_title || neg.counts.marketing) score -= 1.5
  const ruleScore = Math.max(0, Math.min(10, Math.round(score)))

  return {
    chars,
    codeRatio: +code.toFixed(3),
    ruleScore,
    measurable: true,
    flags,
    breadth: { positive: posFired, negative: negFired },
    positive: pos.counts,
    negative: neg.counts,
    hits: [...pos.hits, ...neg.hits].sort((a, b) => b.count - a.count).slice(0, 12),
  }
}

/**
 * Combine the model's human score with the text features.
 *
 * The model keeps the majority vote because it reads meaning; the features can
 * pull a score up when the form is unmistakably hand-written, which is exactly
 * the case a model tends to under-rate. Without a model score the features
 * stand alone.
 */
export function combineHuman(llmHuman, ruleScore) {
  if (typeof llmHuman !== 'number') return ruleScore
  const blended = 0.65 * llmHuman + 0.35 * ruleScore
  // A card the model rejects outright is not talked back in by surface features:
  // first-person markers are trivially imitable by exactly the content the model saw through.
  const cap = llmHuman < 4 ? llmHuman + 1 : 10
  return Math.max(0, Math.min(10, Math.round(Math.min(blended, cap))))
}
