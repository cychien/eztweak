/** JSX folds a source newline into a space, which is visible between CJK
 *  glyphs, so long copy lives in a constant rather than inline text. */
const LEDE =
  'Cadence 從你團隊已經在用的工具收斂進度，每週自動生成一份人看得懂的摘要。' +
  '不用再為了對齊狀態多開一場 30 分鐘的會。'

export function Hero() {
  return (
    <section className="hero" data-section="hero">
      <div className="shell hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">非同步協作</p>
          <h1>
            週報不用開會寫。
            <br />
            讓進度自己浮出來。
          </h1>
          <p className="lede">{LEDE}</p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#top">
              免費試用 14 天
            </a>
            <a className="btn btn-ghost" href="#top">
              看 2 分鐘介紹
            </a>
          </div>
          <p className="fine-print">不需要信用卡・5 分鐘完成設定</p>
        </div>
        <div className="hero-preview" aria-hidden="true">
          <div className="preview-chrome">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="preview-title">本週摘要・工程團隊</span>
          </div>
          <ul className="preview-body">
            <li>
              <strong>結帳流程改版</strong>
              <span className="pill pill-done">已上線</span>
            </li>
            <li>
              <strong>付款失敗重試</strong>
              <span className="pill">進行中・80%</span>
            </li>
            <li>
              <strong>Webhook 重送機制</strong>
              <span className="pill pill-risk">卡住 3 天</span>
            </li>
            <li>
              <strong>資料庫遷移</strong>
              <span className="pill">排程中</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}
