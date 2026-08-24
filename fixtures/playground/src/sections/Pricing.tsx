import { PlanGrid } from '../ui/PlanGrid'

/** Depth probe: Pricing -> PlanGrid -> PlanCard -> PriceTag, so an annotation on
 *  the price digits reports a four-deep `anchor.components` chain. */
export function Pricing() {
  return (
    <section className="pricing" data-section="pricing">
      <div className="shell">
        <h2>定價</h2>
        <p className="section-lede">按實際使用的人數計費，隨時可以降級。</p>
        <PlanGrid />
      </div>
    </section>
  )
}
