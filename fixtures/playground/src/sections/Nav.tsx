/** `更新紀錄` is a real href to a second document, so the review shell can be
 *  driven across an actual page load. The rest stay anchors. */
const LINKS = [
  { label: '產品', href: '#top' },
  { label: '定價', href: '#top' },
  { label: '更新紀錄', href: '/changelog.html' },
  { label: '文件', href: '#top' },
]

export function Nav() {
  return (
    <header className="nav" data-section="nav">
      <a className="brand" href="#top">
        <span className="brand-mark" aria-hidden="true" />
        Cadence
      </a>
      <nav className="nav-links">
        {LINKS.map((link) => (
          <a key={link.label} href={link.href}>
            {link.label}
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
