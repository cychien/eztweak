const ENTRIES = [
  {
    version: '2026.8',
    title: '摘要現在會標出沒有進展的項目',
    body: '連續兩週沒有動靜的項目會被單獨列出來，不再混在一般進度裡。',
  },
  {
    version: '2026.7',
    title: 'Slack 討論納入收斂範圍',
    body: '公開頻道裡被引用的訊息會一起進到摘要的依據，不用再手動貼連結。',
  },
  {
    version: '2026.6',
    title: '每週摘要可以指定送出時間',
    body: '預設是週五下午四點，現在可以按團隊時區各自設定。',
  },
]

/** A second document, reached by a real href rather than a client-side route.
 *  The overlay is injected per HTML response, so crossing between this page and
 *  the index is what actually destroys and rebuilds it - the only way to
 *  exercise anything that has to survive a navigation. */
export function Changelog() {
  return (
    <>
      <header className="nav" data-section="nav">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          Cadence
        </a>
        <nav className="nav-links">
          <a href="/">回首頁</a>
        </nav>
      </header>
      <main>
        <section className="changelog" data-section="changelog">
          <div className="shell">
            <p className="eyebrow">更新紀錄</p>
            <h1 className="changelog-title">這幾個月改了什麼</h1>
            <ul className="changelog-list">
              {ENTRIES.map((entry) => (
                <li className="changelog-item" key={entry.version}>
                  <span className="changelog-version">{entry.version}</span>
                  <div>
                    <h2>{entry.title}</h2>
                    <p>{entry.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </>
  )
}
