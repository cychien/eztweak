# Write the project's DESIGN.md

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

## What this file is

`DESIGN.md` at the project root captures the project's visual language in broad strokes: the
character of its colour, type, space and form, and the handful of values that anchor them. It is a
direction agents start from when they design, not a specification they are held to. **Keep it
broad.** A file that settles every size, step and shadow leaves the work nothing to decide, and
everything made from it comes out looking alike. The fine detail - the full type ramp, the spacing
scale, the shadow recipes, each component's values - lives in the design system and the code, where
the components step and the work itself put it.

It follows the DESIGN.md format (`npx -y -p @google/design.md designmd spec`): YAML frontmatter
carrying machine-readable tokens, then markdown sections in a fixed order with canonical headings.
Here **the tokens are anchors, not a full set**: the few values the language is recognised by.
Sections may be omitted when irrelevant, but the ones present keep the spec's order and exact
headings, so the file stays portable across DESIGN.md-aware tools.

**Components are not defined here.** A markdown file cannot carry a component's states, variants
and behaviour completely, so the components step turns this file's language into the stack's own
design system and a component set, and records where in `.eztweak/config.json`. This file
therefore carries no `components:` group in its frontmatter and no `## Components` section; a
reader who needs a component goes to the design system. See [components.md](components.md).

## The frontmatter

```yaml
---
name: <project title>
description: <one-line tagline>
colors:
  primary: "#b8422e"
  canvas: "#faf7f2"
  ink: "#1f1d1a"
typography:
  display:
    fontFamily: "Cormorant Garamond, Georgia, serif"
    fontWeight: 300
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1rem"
rounded:
  soft: "8px"
omitted:
  - spacing
---
```

- **Anchors only.** The colours the language is recognised by - the ground, the ink, the accent or
  two - and not every tint and state. One entry per typographic role that has a character of its
  own, usually display and body, with its family and the one or two properties that define it. A
  radius when the form language has one. No scale: a ramp of steps is the design system's.
- **List what you leave out under `omitted`**, so the linter reads a missing group as a decision.
- **Keys describe, not enumerate**: `oxblood-deep`, `canvas`, `ink-mute`, not `blue-800`,
  `gray-100`. The one exception is the main accent, which goes under `primary` because the linter
  expects it. Use the names the project already uses when it has them; do not rename to Material
  defaults.
- **Colours accept any valid CSS colour string.** Hex is the portable default, but keep an
  incumbent `rgb()`, `hsl()` or `oklch()` when that is the project's normative source. One format
  per token, and never the same token restated in prose with a different value.
- **The schema has no place for shadows, motion or breakpoints.** When one is part of the
  character, describe it in prose. Do not invent a top-level group for them.

## The body: canonical sections, in order

1. `Overview`
2. `Colors`
3. `Typography`
4. `Layout`
5. `Elevation & Depth`
6. `Shapes`
7. `Do's and Don'ts`

The format also defines `Components` between Shapes and Do's and Don'ts; this harness leaves it
out on purpose. Omit any other section the project has nothing real for, rather than filling it.
Every section is a short paragraph or a few bullets. The whole file reads in a couple of minutes.

## Step 1: Load current state

- `PRODUCT.md` comes first. If it is missing, run [product.md](product.md) and come back: the
  Overview's voice and the visual constraints come from it.
- Read `.eztweak/config.json` for the stack and the browser tool. If it is missing or names no
  browser tool, run [stack.md](stack.md) and come back.
- If `DESIGN.md` already exists, **do not silently overwrite it**. Show the user what is there, and
  ask whether to refresh, overwrite or merge. Use the structured question tool when available;
  otherwise ask and wait.
- Decide the path by scanning first (Scan mode, Step 2). If the scan finds no tokens, no component
  files and no rendered site, offer Seed mode; do not switch silently.

## Scan mode: read the language the project already speaks

The project has tokens, components or rendered output. This is the default.

### Step 2: Look at what exists

Read the sources for the values the project defines, and the rendered page for which of them
carry it:

- **The sources**: CSS custom properties, the Tailwind config or `@theme` block, CSS-in-JS theme
  files, token files, the global stylesheet, and the main components - button, card, input,
  navigation, dialog.
- **The rendered page**: at the url your prompt gives, otherwise at the dev server, which you
  start if it is not up. Measure it with `node <skill>/scripts/page.mjs measure <url>`, where
  `<skill>` is the folder above this file's `reference/`: it renders the page at desktop and at
  390px and tallies what the visible elements use - text, background and border colours, each
  background's share of the screen, families, sizes, weights, line heights, radii, shadows,
  padding, gaps and container widths - with the project's own tokens. **Frequency** is what a
  stylesheet cannot tell you: the colour on three hundred elements is the ground, the one on two is
  the accent, a rule matching nothing is not in the language, so let the counts say what dominates.
  A `redirected` field means it measured the page the url sent it to, a sign-in most of the time,
  not the product: measure a path that stays, or lean on the sources.
  Look at it too: `node <skill>/scripts/page.mjs shots <url> <dir>` writes a desktop and a mobile
  screenshot into a folder outside the project. Only when the script cannot run - there is no
  Chrome - do the same with the browser tool.

Where a source and the page disagree, the page is what users see.

### Step 3: Name the character

From what you found, say what the language is, not everything it contains:

- **Colour**: the ground, the ink, the accent, and how much of a screen the accent gets.
- **Type**: the pairing and the contrast between display and body; how large, how tight, how
  loud the scale runs. Not each step.
- **Space**: dense or airy, and whether the rhythm is even or varied.
- **Depth and form**: flat, layered or lifted; sharp, softened or round.

Stop at what defines it. A value that appears once is drift, and a value the language does not
depend on belongs to the design system.

### Step 4: Ask for what cannot be extracted

The rest is judgment, and the user is the client. Ask in two rounds of at most three questions
each, waiting between rounds, each question led by your own proposal so the client corrects rather
than composes. Use the structured question tool when available; otherwise ask and wait. Choose the
questions for this project from these, skip any the page already answers plainly, and add one of
your own when the project needs it:

- **Overview voice**: mood adjectives, the aesthetic philosophy in two or three sentences, and the
  anti-reference - what this must never be mistaken for.
- **Elevation philosophy**: flat, layered or lifted.

Carry a line from `PRODUCT.md` only when it is a durable brand commitment that actually constrains
the visual system. Page strategy and surface concepts do not belong here.

### Step 5: Write DESIGN.md

The frontmatter, then the body:

```markdown
# Design System: [Project Title]

## Overview

[Two short paragraphs, in plain words: personality, density and aesthetic philosophy, and the
anti-reference. No named metaphor - a metaphor becomes the idea every later design reaches for.
End with a short **Key Characteristics:** list, three to five bullets.]

## Colors

[The palette's character in a sentence or two, then one line per anchor.]
- **[Descriptive Name]** (`{colors.canvas}`): [Its role, and roughly how much of a screen it gets.]

## Typography

**Display Font:** [Family] (with [fallback])
**Body Font:** [Family] (with [fallback])

[The pairing's personality, and how the scale behaves - its contrast and its loudness - in one or
two sentences. Not a list of steps.]

## Layout

[Density and rhythm, and the spatial idea in a sentence or two.]

## Elevation & Depth

[Flat, layered or lifted, in a sentence or two. "No shadows" is said explicitly, with how depth is
conveyed instead.]

## Shapes

[The form language in a sentence or two.]

## Do's and Don'ts

### Do:
- **Do** [a tendency the language has].

### Don't:
- **Don't** [a direction the language is not, which the incumbent system or the user confirmed].
```

### Step 6: Lint, confirm, refine

Run `npx -y -p @google/design.md designmd lint DESIGN.md` and fix what it reports, in the
document. Writing this file changes no other file: measuring a page turns up things that are wrong
with it, and they are the document's subject, not your to-do list.

Then show the user what you wrote, point out the creative choices that were yours (the colour names
you gave the palette, the voice) and which parts you asked rather than measured, and offer to revise a section. When
this step runs as part of a larger request, put that offer in one line at the end of its reply
instead, and do not stop to wait for an answer.

## Seed mode: a visual language before there is code

### Step 1: `PRODUCT.md`

It is the prerequisite. If it is missing, run [product.md](product.md) and come back.

### Step 2: Derive and write

Propose a visual language from `PRODUCT.md`, and discuss it with the user before writing. The
product's job sets the density and the register of the type: a dashboard for people who read
numbers all day is dense, with a small, tight body scale (12px and 14px labels are right there); a
brochure for a first visit is airy, with a large display scale and few colours. The brand
commitments set the colours and marks that are fixed; everything else is a proposal, led by you and
confirmed by the client in rounds of at most three questions. Write the same file as Scan mode,
with the anchors you proposed as the frontmatter, and mark it as a seed in the Overview. Re-run in
Scan mode once there is code.

## Style guidelines

- **Character over quantity.** Say what the language is like, and give the value only where it is
  the anchor. A reader should come away knowing what belongs and what does not, with the decisions
  inside that left to them.
- **Tendencies, not requirements**: "leans on", "mostly", "reaches for". The file is a direction;
  write it as one.
- **Descriptive over technical**: "Gently curved edges (8px)" over `rounded-lg`. Lead with the
  description, put the value in parentheses.
- **Specific to this product.** Prose that would read the same pasted onto another product has
  captured nothing.

## Pitfalls

- Do not paste raw class names; translate them.
- Do not write out scales: no type ramp, spacing scale, shadow recipe or per-state colour. They
  are the design system's.
- Do not document components here; they are the components step's.
- Do not overwrite an existing `DESIGN.md` without asking.
- Do not duplicate `PRODUCT.md`; this file is strictly visual.
- Do not rename or paraphrase the canonical headings: `Colors`, not "Color Palette"; `Typography`,
  not "Typography Rules". Tooling parses the exact headers.
- Do not add frontmatter groups outside `colors`, `typography`, `rounded`, `spacing` and `omitted`.
