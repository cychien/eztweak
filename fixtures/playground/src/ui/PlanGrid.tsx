import { PlanCard } from './PlanCard'

const PLANS = [
  {
    name: 'Starter',
    price: 0,
    blurb: '最多 5 人的小團隊，單一工作區。',
    perks: ['每週一份摘要', '兩個整合來源', '30 天紀錄'],
  },
  {
    name: 'Team',
    price: 12,
    blurb: '需要跨組看見彼此進度的團隊。',
    perks: ['不限摘要頻率', '所有整合來源', '風險自動標記', 'Slack 推送'],
    featured: true,
  },
  {
    name: 'Business',
    price: 28,
    blurb: '有稽核與權限需求的組織。',
    perks: ['SSO 與 SCIM', '稽核紀錄', '自訂保留期限', '專屬客戶經理'],
  },
]

export function PlanGrid() {
  return (
    <div className="plan-grid">
      {PLANS.map((plan) => (
        <PlanCard key={plan.name} {...plan} />
      ))}
    </div>
  )
}
