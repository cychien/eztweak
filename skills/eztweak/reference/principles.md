# Design principles

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

Read this before you build, after [baseline.md](baseline.md): the baseline is the standard every
piece is held to, and what follows puts it into practice.

Three kinds of rule live here and they bind differently. The **anti-slop defaults** say what not
to reach for when nothing asked for it. The **craft floor** holds whatever the direction is. The
**design system** section says to start from the direction the project already documents.

## Against AI slop

These are the tells that mark a page as machine-made: each is cheap to reach for and expensive to
justify. Every one is a **default, not a ban**. The project's `DESIGN.md`, a pinned brief, a precedent's
move, or the user asking for it in so many words can earn any of them back, and when one of them is what the
design actually needs, use it. What the defaults rule out is the reflex.

### Page structure

- **Do not number sections** (01 / 02 / 03) unless the sequence carries information the reader
  needs, such as steps that have to be done in order.
- **Do not put a task in a modal** when it needs neither interruption nor protected focus.

### Borders and edges

- **No thick coloured border on one side of a card.** The side-tab accent is the most recognisable
  tell there is.
- **No thick accent border on a rounded element.** The border and the radius fight each other, so
  drop one of them.
- **Do not pair a hairline border with a wide diffuse shadow.** Commit to a defined edge or to a
  soft elevation, not to both at once.

### Colour and light

- **Purple and violet gradients, cyan on dark, and cream or beige page backgrounds need an explicit
  reason.** Without one they are off the table; with one they are yours to use. These are the
  palettes every generator reaches for by reflex.
- **Do not use glowing shadows**: a zero-offset coloured halo on any background, or any coloured
  blurred shadow on a dark one. A shadow carries an offset and a soft blur; a halo is decoration.
- **Do not reach for gradient text.** Gradient type needs a reason, not a mood.
- **Do not use hard offset shadows** (`box-shadow: 4px 4px 0`) outside a world that is actually
  neobrutalist. The zero-blur block shadow is a costume, not a depth system.

### Type and icons

- **Monospace is for code.** Mono worn as a costume for "technical" is a tell.
- **Do not use emoji or Unicode glyphs as an icon system.** Icons are drawn, from a real library or
  authored SVG, in one consistent stroke and weight.
- **Do not crush letter spacing** past the point where characters keep their own shapes. Tighten
  display type optically, not destructively.

### Layout and motion

- **Do not use one spacing value everywhere.** Tight groupings for related items, generous
  separation between sections; the variation is the rhythm.
- **Do not use bounce or elastic easing.** Real objects decelerate smoothly, so use an exponential
  ease-out.
- **Do not use a pulsing status dot** unless it is tied to genuinely live, changing data. A static
  indicator with a clear label is honest and calmer.

### Imagery

- **Do not approximate an organic contour with a geometric mask.** A circle, polygon or
  radial-gradient cutout traced around a photographic subject reads worse than leaving the effect
  out. Derive an alpha matte from the image, or produce a real cut-out asset.
- **Do not assemble an illustration out of primitive shapes.** A hero-sized inline SVG built from a
  pile of rects and circles reads as placeholder clip art. Icons and data graphics are fine at
  their own scale.

### Copy you write

- **Do not lean on em dashes.** Commas, colons, periods and parentheses carry the same joins.
- **No SaaS buzzwords**: streamline, empower, supercharge, unleash, world-class, enterprise-grade,
  next-generation, cutting-edge, best-in-class, industry-leading, seamless, harness the power. Pick
  a specific verb and noun that says what the product literally does.
- **No aphoristic cadence.** "Not a feature. A platform." and "X. Just Y." are a rhythm, not a
  voice. Once is fine; the pattern is the tell.

### Theme

- **Default to a light page.** Build a dark theme only when the user asks for it, or `DESIGN.md`
  commits to it. One dark surface on a light page - a popover, a focal panel - is contrast, not a
  theme.

## The craft floor

These hold whatever the direction is. Each is a check on the built result, judged by looking at
it, not a number to hit: the right size, measure and spacing depend on how dense the page has to be.

### Legibility

- **Text reads without effort** at the size, contrast, line length and line height it is set in,
  for the density the page needs. Nothing is so small, so long or so tightly set that reading it is
  work.
- **Never grey text on a coloured background.** Tint the secondary text from that hue, or use white
  or near-white.
- **Text does not touch its container or the edge of the viewport.**

### Layout and overflow

- **No card inside a card.** This is about nesting cards: a card - a container with its own
  background, border or shadow - never holds items that are cards themselves. Inside a card, set the
  members apart with space, faint dividers or type; when the members need to be cards, drop the
  container. A fill that marks a row's state - hover, selected, the current step - is a highlight,
  not a card, and is fine inside one; so are a badge, an input and a button. This holds whatever
  `DESIGN.md` or a precedent suggests.
- **Content lines up with content.** The text and icons of a row, a menu item or any trigger start
  on the same edge as the heading and text around them. Its hover or selected background is what
  gives way: it may reach past the container's padding, so the content never shifts inward to make
  room for it.
- **Nothing overflows its container.** Let text wrap, constrain the width, or give the region a
  deliberate scroll affordance.
- **A secondary card's description stops at three lines.** Past that, it ends in an ellipsis with a
  "more" control beside it that expands the full text in place. The main content of a page is not
  cut short this way.
- **A clipping container does not swallow a popover.** Tooltips, menus and popovers that need to
  escape must not sit inside `overflow: hidden`.
- **Cards in a horizontal scroller keep the same inset on both sides**, so their edges and rounded
  corners are not cut off at rest.
- **Animate transform and opacity, not layout.** Width, height, padding and margin cause layout
  thrash; use `grid-template-rows` for a height change.

## The project's design system

Start from the language `DESIGN.md` describes and the design system's tokens. Keep to the tokens
as closely as the system is complete: a full system is the product's language, a sparse one only a
hint. A value that keeps coming up becomes a token in the system; the document is not edited for
it.
