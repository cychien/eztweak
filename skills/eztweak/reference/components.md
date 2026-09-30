# Build the project's design system and components

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

## What this step is

`DESIGN.md` says what the visual language is, in broad strokes. This step makes it real in the
stack: its anchors and its character become the design system the project actually builds with, and a set of components is built on
that system in the project's own component library. That set is the foundation the making step
builds UI from.

The stack step has already recorded which design system and which component library the project
uses, in `design_system` and `components` in `.eztweak/config.json`. This step builds to them and
adds one field, the list of primitives that now exist, so the making step reuses rather than
reinvents:

```json
"components": {
  "library": "shadcn",
  "path": "src/components/ui",
  "primitives": ["button", "input", "card", "dialog"]
}
```

## The invariant: nothing visible changes

When this step is done, every existing screen renders exactly as it did. The project's rules and
documents get more complete; its UI does not move. Concretely:

- **The existing system wins.** Where the project's config or components disagree with
  `DESIGN.md`, keep the project's value untouched and report the divergence to the user; the
  correction, if they want one, is a refresh of `DESIGN.md`, not an edit to what renders.
- **New tokens take new keys.** A token `DESIGN.md` has and the system lacks is added under a key
  nothing uses yet. An existing key is never renamed, retuned or repurposed.
- **New components do not replace used ones.** An existing component stays as it is, even when a
  cleaner one could be built; new primitives are added beside it and wired into nothing.

## Step 1: Load current state

`PRODUCT.md`, `DESIGN.md` and `.eztweak/config.json` with a stack and a browser tool are the
prerequisites; run [product.md](product.md), [design.md](design.md) or [stack.md](stack.md) for
whichever is missing, and come back.

Then read what the project already has: the design system at `design_system.path`, and the
components at `components.path`, with each one's variants and states. If `components.primitives`
is recorded and still matches the directory, there is nothing to do here; say so in one line and
go on.

## Step 2: The design system

Carry `DESIGN.md`'s anchors - its colours, type roles and radius - into the design system, in the
idiom `design_system.kind` names, under the invariant above. When `design_system` is `null`, create
one in the stack's own idiom and record it there. Keep `DESIGN.md`'s descriptive names (`canvas`,
`oxblood-deep`) as the keys, so a class or variable reads like the document.

The document is deliberately broad, so the scales it does not write out are this step's: where the
system has none yet, derive them in the language's character - a type ramp with the contrast its
Typography describes, a spacing scale with the density its Layout describes, shadows as its
Elevation & Depth describes. They live in the design system; `DESIGN.md` is not edited for them.

## Step 3: The component set

Build the primitives the product needs and the project lacks: from `PRODUCT.md`'s workflows, the
set the making step will reach for - button, input, select, checkbox, card, dialog, navigation,
badge, tooltip, table - and no component the product has no use for. Each carries every state it
can be in: hover, focus-visible, active, disabled, error, loading where it applies.

**Write them the way the project already writes components.** `components.library` says how:

- **A component library** (`shadcn`, `mui`, `chakra`, `mantine`, and so on): new primitives come
  from that library, used the way it is meant to be used. With `shadcn`, add them through its own
  CLI (`npx shadcn@latest add <name>`) so they land where `components.json` says and in shadcn's
  structure; check first which ones exist, add only the missing ones, and never pass `--overwrite`.
  The CLI can touch shared files, the global stylesheet and the Tailwind config, so read its diff
  against the invariant. With any other library, compose its components and theme them through its
  theme, not with overrides on each instance.
- **`custom`**: written by hand, after reading two or three of the existing components, in their
  file layout, naming, props, variant API and styling approach.
- **`none`**: written by hand in the stack's idiom, at `components.path`.

Whatever the source, style every primitive from the design system's tokens, so it speaks the
product's language. A library's default look stays where it already fits `DESIGN.md`'s direction;
it is restyled only where it does not.

Look for precedent before designing a component: [inspiration.md](inspiration.md), searched by what
the component is and has to show.

## Step 4: Verify the invariant, then record

Before writing anything, screenshot the project's main screens:
`node <skill>/scripts/page.mjs shots <url> <dir>/before <path> ...`, where `<skill>` is the folder
above this file's `reference/`, `<url>` the running page and `<dir>` a folder outside the project;
it shoots every path at desktop and at 390px. After writing, shoot them again into `<dir>/after`
and run `node <skill>/scripts/page.mjs compare <dir>/before <dir>/after`. Every line must say
`same`; any difference is a change to undo, not a finding to report. Only when the script cannot
run - there is no Chrome - do the same with the browser tool. Then write `components.primitives` into
`.eztweak/config.json`, and `design_system` when this step created one.

Tell the user in a few lines what the design system now carries, which primitives were added and
where, and every divergence between `DESIGN.md` and the existing system that you left as it was.
When this step runs as part of a larger request - a setup turn, or a batch that needed it first - skip this and let that request's reply cover it. Then end, or resume the request that invoked this.
