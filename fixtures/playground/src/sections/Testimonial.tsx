/** A long unbroken quote: select a phrase mid-sentence and `anchor.text` has to
 *  carry that exact substring, not the whole block. */
const QUOTE =
  '我們以前每週一早上開 45 分鐘的同步會，每個人輪流講自己在幹嘛，講完大家也記不住別人講了什麼。' +
  '換成 Cadence 之後那場會直接取消了，改成週五自動發一份摘要出來，禮拜一大家帶著問題進來討論就好。' +
  '最有感的是它會主動標出卡住的項目 - 以前那種「拖了三週才有人發現」的狀況，現在第二週就會被抓出來。'

export function Testimonial() {
  return (
    <section className="testimonial" data-section="testimonial">
      <figure className="shell quote">
        <blockquote>{QUOTE}</blockquote>
        <figcaption className="quote-by">
          <span className="avatar" aria-hidden="true" />
          <span>
            <strong>陳彥廷</strong>
            <span className="quote-role">Northwind・工程總監</span>
          </span>
        </figcaption>
      </figure>
    </section>
  )
}
