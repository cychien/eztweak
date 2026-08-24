import { PriceTag } from './PriceTag'

interface PlanCardProps {
  name: string
  price: number
  blurb: string
  perks: string[]
  featured?: boolean
}

export function PlanCard({ name, price, blurb, perks, featured = false }: PlanCardProps) {
  return (
    <article className={featured ? 'plan-card plan-card-featured' : 'plan-card'}>
      {featured && <span className="plan-badge">最多人選</span>}
      <h3 className="plan-name">{name}</h3>
      <PriceTag amount={price} />
      <p className="plan-blurb">{blurb}</p>
      <a className={featured ? 'btn btn-primary btn-block' : 'btn btn-block'} href="#top">
        {price === 0 ? '免費開始' : '選擇 ' + name}
      </a>
      <ul className="plan-perks">
        {perks.map((perk) => (
          <li key={perk}>{perk}</li>
        ))}
      </ul>
    </article>
  )
}
