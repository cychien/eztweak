const COLUMNS = [
  { title: '產品', links: ['功能', '定價', '整合', '更新紀錄'] },
  { title: '資源', links: ['文件', '部落格', '客戶案例', '狀態頁'] },
  { title: '公司', links: ['關於我們', '職缺', '隱私權', '服務條款'] },
]

export function Footer() {
  return (
    <footer className="footer" data-section="footer">
      <div className="shell footer-grid">
        <div>
          <a className="brand" href="#top">
            <span className="brand-mark" aria-hidden="true" />
            Cadence
          </a>
          <p className="footer-note">給遠端團隊的非同步進度同步工具。</p>
        </div>
        {COLUMNS.map((column) => (
          <div key={column.title}>
            <h3>{column.title}</h3>
            <ul>
              {column.links.map((link) => (
                <li key={link}>
                  <a href="#top">{link}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="shell footer-base">
        <span>© 2026 Cadence Labs</span>
        <span>台北・遠端優先</span>
      </div>
    </footer>
  )
}
