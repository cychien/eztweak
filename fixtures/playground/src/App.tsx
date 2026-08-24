import { Faq } from './sections/Faq'
import { Features } from './sections/Features'
import { Footer } from './sections/Footer'
import { Hero } from './sections/Hero'
import { Logos } from './sections/Logos'
import { Nav } from './sections/Nav'
import { Pricing } from './sections/Pricing'
import { Stats } from './sections/Stats'
import { Testimonial } from './sections/Testimonial'

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Logos />
        <Features />
        <Stats />
        <Testimonial />
        <Pricing />
        <Faq />
      </main>
      <Footer />
    </>
  )
}
