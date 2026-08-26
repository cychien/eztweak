# playground

A fake landing page for a fake product (Cadence) that `npm run dev` serves as the
review target. It is deliberately a normal marketing page rather than a grid of
test blocks, because the thing under test is whether an annotation on ordinary
markup resolves to something an agent can act on.

Every anchor layer in `Anchor` (`src/protocol.ts`) has a section that exercises it:

| Section | `data-section` | What it probes |
| --- | --- | --- |
| Pricing | `pricing` | `anchor.components` - `Pricing → PlanGrid → PlanCard → PriceTag` is a four-deep chain |
| Logos | `logos` | `anchor.point.rel` - a full-bleed strip where a pin is ambiguous without the 0-1 fractions |
| Testimonial | `testimonial` | `anchor.text` - one long quote, so a mid-sentence selection must come back exactly |
| Stats | `stats` | `anchor.viewport` - three columns that break at 390 and must be fixed at that breakpoint only |
| Nav / Hero / Features / FAQ / Footer | each named | `anchor.section` and `anchor.selector` on everyday markup |

`changelog.html` is a second document, linked from the nav's 更新紀錄 as a real
href rather than a client-side route. The overlay is injected per HTML response,
so crossing between the two pages is what destroys and rebuilds it - the only way
to exercise anything that has to survive a navigation, such as an `/element` pick
that continues on the other page.

`vite.config.ts` loads `eztweakSource()` straight from `src/`, so annotations
carry `anchor.source` as `file:line`. Run `npm run dev -- --no-plugin` to serve the
same page through `vite.noplugin.config.ts` instead and see what an agent gets
when only the fallback layers are available.

Long CJK copy lives in constants rather than inline JSX text: JSX folds a source
newline into a space, which is invisible between Latin words and very visible
between CJK glyphs.
