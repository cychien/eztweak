const STATS = [
  { value: '4.5 小時', label: '每位 manager 每週省下的會議時間' },
  { value: '92%', label: '摘要不需要人工修改就能直接發出' },
  { value: '1,200+', label: '正在使用的團隊' },
]

/** The values are long enough that three columns collapse badly on a narrow
 *  viewport - annotate it at 390 and check `anchor.viewport` says `mobile`. */
export function Stats() {
  return (
    <section className="stats" data-section="stats">
      <div className="shell stat-row">
        {STATS.map((stat) => (
          <div className="stat" key={stat.label}>
            <p className="stat-value">{stat.value}</p>
            <p className="stat-label">{stat.label}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
