export function PriceTag({ amount }: { amount: number }) {
  return (
    <p className="price-tag">
      <span className="price-currency">$</span>
      <span className="price-amount">{amount}</span>
      <span className="price-period">/ 人 / 月</span>
    </p>
  )
}
