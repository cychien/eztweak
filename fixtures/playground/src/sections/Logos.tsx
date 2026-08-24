const CUSTOMERS = ['Northwind', 'Lumen', 'Basecamp 2', 'Hoyt & Co', 'Trellis', 'Kite']

/** Full-bleed and evenly spaced: pinning it anywhere resolves to the same strip,
 *  so `anchor.point.rel` is the only thing telling left from right. */
export function Logos() {
  return (
    <section className="logos" data-section="logos">
      <div className="shell">
        <p className="logos-label">已經有 1,200 個團隊每週在用</p>
        <div className="logos-row">
          {CUSTOMERS.map((name) => (
            <span key={name} className="logo">
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
