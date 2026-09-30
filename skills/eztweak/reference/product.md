# Write the project's PRODUCT.md

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

## What this file is

`PRODUCT.md` at the project root captures durable product truth: who the product is for and what
job they are doing, what it makes possible, what position it holds, and what future work must
preserve. It outlives any particular screen, and every later design decision is measured against
it.

It does not invent a visual world and it does not write `DESIGN.md`. Palettes, typography,
components, page concepts, and how the product should feel belong to `DESIGN.md`; none of that is
asked about or written here.

This works with or without a review session. The evidence is the project itself. A running page,
when one is open, is one more thing to read, not a requirement.

## Step 1: Load current state

Look for `PRODUCT.md` at the project root.

- **No `PRODUCT.md`:** explore, interview, and write it (steps 2-4).
- **`PRODUCT.md` exists:** leave it. Say so in one line and go on with what you were asked to do.
- **Only `DESIGN.md` exists:** leave it untouched and create `PRODUCT.md` (steps 2-4).

Never silently overwrite an existing file, and never offer `DESIGN.md` during this work. If
another request invoked this, finish `PRODUCT.md` first, then resume it.

## Step 2: Explore the project

Before asking anything, scan what the project already says about itself:

- brand and product assets, docs, and copy: README, product docs, marketing copy, the strings in
  the source, and the rendered page when one is running;
- app boundaries, features, workflows, routes, and roles;
- names, logos, legal and proof assets, and existing brand commitments.

Treat everything you find as a hypothesis about the user's intent, not as their answer. The
exploration gives you context; the interview settles which of it is real product truth.

## Step 3: Interview for product truth

Ask the user about what you observed or inferred, and confirm the real product truth. A fact with
strong evidence needs no question - a distinctive logo, a clearly defined document - so record
those as product truth rather than spending the user's attention on them.

Use the structured question tool when available; otherwise ask and wait. Keep rounds to at most
three focused questions and require one real answer or approval round before writing a new
`PRODUCT.md`. Confirm inferences.

The interview exists to settle three things. They are goals, not questions to read out:

1. Who the primary user is, in what situation, and what job they are doing.
2. What the product makes possible, and its meaningfully different mechanism or position.
3. What durable constraints, assets, evidence, or product facts future work must preserve.

Find the answers wherever they are: what the exploration settled is recorded, and only what it
left open is asked, in questions you write for this project. Start with the open unknowns that
most change future product decisions.

Do not ask about aesthetic direction, emotional feel, visual references, colors, typography, or
style. If the user volunteers a binding visual constraint, record it under Brand Commitments as
stated; do not develop it.

### What belongs in PRODUCT.md

- users, jobs, workflows, purpose, success, positioning, and operating context;
- capabilities, constraints, terminology, evidence, platform, and accessibility;
- confirmed voice, assets, and brand commitments.

### What does not belong

- visual worlds, palettes, typography, components, or page concepts;
- visitor mode, narrative, CTA/proof sequence, or other surface strategy;
- invented testimonials, customers, benchmarks, pricing, licensing, or deployment claims;
- a requirement to decide every optional field.

## Step 4: Write PRODUCT.md

Write only confirmed facts and explicitly marked open decisions. Omit a section you have nothing
real for rather than filling it with generic prose.

```markdown
# Product

## Users
[Primary users, their situation, and job. Add other audiences only when confirmed.]

## Product Purpose
[What the product does, why it exists, and what success means.]

## Positioning
[The product mechanism or claim a neighboring product could not truthfully copy.]

## Operating Context
[Workflows, environments, tools, documents, materials, and rituals that are factual parts of using
or evaluating the product.]

## Capabilities and Constraints
[Confirmed functionality, technical constraints, terminology, and explicitly undecided product
facts.]

## Brand Commitments
[Existing name, voice, assets, personality, identity constraints, and references the user
explicitly made binding. Omit when none exist.]

## Evidence on Hand
[Real content, data, demonstrations, testimonials, case studies, press, or assets, with paths where
applicable. State absences that future work must not fabricate.]

## Product Principles
[Three to five durable strategic principles derived from confirmed answers; no visual recipes.]

## Accessibility & Inclusion
[Known user needs or required standard. Omit when no product-specific requirement was
established.]
```

Write it to `PROJECT_ROOT/PRODUCT.md`. It is finished before any visual-world or surface-concept
work begins.

## Step 5: Wrap up or resume

Tell the user in two or three lines which product facts are now captured, which were confirmed,
and which are marked open. When this step runs as part of a larger request - a setup turn, or a batch that needed it first - skip this and let that request's reply cover it. Then end, or resume the request that invoked this.
