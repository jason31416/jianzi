import Image from 'next/image'
import { pool } from '@/lib/pool'
import styles from './page.module.css'

/**
 * Proof sheet. Scaffolding only — it shows that the pool loads and what each card
 * actually carries, so the curation pass can see the gaps. The card table and the
 * flip-to-column view replace this page; see DESIGN.md.
 */
export default function Page() {
  const withComments = pool.filter((c) => c.comments.length > 0).length
  const withBadge = pool.filter((c) => c.author?.badge).length
  const needsCuration = pool.filter((c) => !c.domain || !c.reason).length

  return (
    <main className={styles.sheet}>
      <header className={styles.masthead}>
        <h1 className={styles.title}>见字</h1>
        <p className={styles.tagline}>
          一张一张地遇见知乎上那些写得认真的人，然后走进去读完他写的东西。
        </p>
      </header>

      <div className={styles.status}>
        <span>{pool.length} 张卡</span>
        <span>
          {withBadge} 张有认证文案
        </span>
        <span>{withComments} 张有精选评论</span>
        <span className={needsCuration ? styles.todo : undefined}>
          {needsCuration} 张待补领域与理由
        </span>
      </div>

      {pool.map((card) => (
        <article key={card.id} className={styles.entry}>
          <h2 className={styles.head}>{card.title}</h2>

          <div className={styles.byline}>
            {card.author ? (
              <>
                {card.author.avatar && (
                  <Image
                    className={styles.avatar}
                    src={card.author.avatar}
                    alt=""
                    width={28}
                    height={28}
                  />
                )}
                <span>{card.author.name}</span>
                {card.author.badge && <span>· {card.author.badge}</span>}
              </>
            ) : (
              <span>署名不详</span>
            )}
          </div>

          <p className={styles.excerpt}>{card.excerpt}</p>

          <div className={styles.meta}>
            知乎 · {card.stats.year} · {card.stats.votes} 赞 · {card.stats.comments} 评
            {card.comments.length > 0 && ` · ${card.comments.length} 条精选评论`}
            {(!card.domain || !card.reason) && (
              <span className={styles.todo}> · 待补领域与理由</span>
            )}
          </div>
        </article>
      ))}
    </main>
  )
}
