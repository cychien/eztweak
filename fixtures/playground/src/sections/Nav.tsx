const LINKS = ['產品', '定價', '客戶案例', '文件']

export function Nav() {
  return (
    <header className="nav" data-section="nav">
      <a className="brand" href="#top">
        <span className="brand-mark" aria-hidden="true" />
        Cadence
      </a>
      <nav className="nav-links">
        {LINKS.map((link) => (
          <a key={link} href="#top">
            {link}
          </a>
        ))}
      </nav>
      <div className="nav-actions">
        <a className="link-quiet" href="#top">
          登入
        </a>
        <a className="btn btn-primary btn-sm" href="#top">
          免費試用
        </a>
      </div>
    </header>
  )
}
