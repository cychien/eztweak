import { FeatureCard } from '../ui/FeatureCard'

const FEATURES = [
  {
    title: '自動收斂進度',
    body: '接上 GitHub、Linear 與 Slack，Cadence 會辨識哪些是真的有進展，哪些只是被移動了一次卡片。',
  },
  {
    title: '寫給人看的摘要',
    body: '不是把 commit 列表貼給你。每則摘要都有一句話結論、影響到誰，以及下一步卡在什麼地方。',
  },
  {
    title: '風險自己浮上來',
    body: '連續兩週沒動的項目會自動標記。你不用去問「那個還在跑嗎」，它會先來找你。',
  },
]

export function Features() {
  return (
    <section className="features" data-section="features">
      <div className="shell">
        <h2>把「同步狀態」這件事從行事曆上拿掉</h2>
        <p className="section-lede">
          多數週會的一半時間花在唸大家都能自己讀的東西。Cadence 負責那一半。
        </p>
        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <FeatureCard key={feature.title} {...feature} />
          ))}
        </div>
      </div>
    </section>
  )
}
