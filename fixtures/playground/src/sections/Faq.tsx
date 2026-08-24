const QUESTIONS = [
  {
    q: '需要團隊改變現有的工作流程嗎？',
    a: '不用。Cadence 只讀你已經在用的工具，不要求任何人多填一個欄位或多開一個看板。設定完成後就不需要再維護。',
  },
  {
    q: '摘要可以自己調整嗎？',
    a: '可以。每份摘要在寄出前都會先進到你的收件匣，你可以直接編輯內容、刪掉不想公開的項目，或是改寫結論那一句。',
  },
  {
    q: '資料會被拿去訓練模型嗎？',
    a: '不會。你的資料只用於產生你自己團隊的摘要，不會進入任何共用的訓練流程，也可以隨時要求刪除。',
  },
]

export function Faq() {
  return (
    <section className="faq" data-section="faq">
      <div className="shell">
        <h2>常見問題</h2>
        <dl className="faq-list">
          {QUESTIONS.map(({ q, a }) => (
            <div className="faq-item" key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
