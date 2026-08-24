export function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="feature-card">
      <span className="feature-mark" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  )
}
