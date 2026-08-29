/** The pick transaction, as a reducer.
 *
 *  A pick outlives the document that started it: the user goes off to point at
 *  something, and the page they were composing on may be replaced on the way.
 *  Only the shell survives that, so only the shell can hold the state - and the
 *  state is worth holding carefully, because the failure mode is not a wrong
 *  pixel. `attachify.discard()` deletes uploaded files, so a transition that
 *  drops a composer the user is still writing in takes their screenshots with
 *  it.
 *
 *  Written as a pure function of (state, event) so that the abort paths, the
 *  stale-id races and the re-arm-after-navigation replay can be tested at all:
 *  the shell's tests have no DOM. */

import { dropDraftRef, draftBelongsHere, resolveDraftRef } from './draft.js'
import type { DraftWire, RefWire } from './draft.js'

export type PickHost = 'popup' | 'note'

/** Why the shell is calling a pick off. */
export type AbortReason = 'escape' | 'mode' | 'sent' | 'ended'

export interface PickState {
  id: string
  host: PickHost
  /** `picking` while the user is choosing; `returning` once we have asked the
   *  iframe to go back to the page the composer is waiting on. */
  phase: 'picking' | 'returning'
  /** False until the overlay has confirmed it is listening. A pick that never
   *  gets confirmed is a page with no overlay in it - a crashed app, a build
   *  error screen - and has to time out rather than hang. */
  armed: boolean
  /** The popup's contents, as data. Null for the note box, which never dies. */
  draft: DraftWire | null
  /** Set once the pick has landed but the composer is somewhere else. */
  ref: RefWire | null
  /** The frame holding the pick, once one does. Null while it is still out to
   *  every frame at once, which is how a pick from the note box starts: no frame
   *  asked for it, so any of them may answer it. A pick from an overlay's own
   *  popup belongs to that frame from the first event. */
  frame: string | null
  /** Last page the iframe reported. */
  page: string | null
  /** When the current arm attempt started, for the timeout. */
  armedAt: number
  /** Navigations spent getting back. Bounded: an app that redirects away from the
   *  page we are trying to reach would otherwise be chased forever. */
  returns: number
}

export type PickEvent =
  /** The shell's own composer started one. */
  | { t: 'arm'; id: string; host: PickHost; now: number }
  /** The overlay is listening. Also the first the shell hears of a pick that
   *  started inside the overlay's own popup. */
  | { t: 'armed'; id: string; host: PickHost; now: number; frame?: string }
  | { t: 'draft'; id: string; draft: DraftWire; frame?: string }
  | { t: 'picked'; id: string; ref: RefWire; page: string; frame?: string }
  /** The overlay handled the whole thing itself: its popup was still alive. */
  | { t: 'draft-done'; id: string }
  /** `resumed` says whether the overlay handed a live popup back. If it did,
   *  the shell's copy is stale and must simply be dropped. */
  | { t: 'cancelled'; id: string; resumed: boolean; frame?: string }
  | { t: 'ready'; page: string; now: number; frame?: string }
  /** The draft outlived the window its attachment ids stay resolvable in. */
  | { t: 'expired'; id: string; frame?: string }
  | { t: 'abort'; reason: AbortReason }
  | { t: 'tick'; now: number }

/** `frame` names the one frame an effect is aimed at. Left off, it is aimed at
 *  every frame there is - which is the only kind of effect a shell showing a
 *  single preview ever produces. */
export type PickEffect =
  | { do: 'arm-overlay'; id: string; host: PickHost; returnTo?: string; frame?: string }
  | { do: 'abort-overlay'; id: string; frame?: string }
  /** Everyone but the frame that answered. A pick armed on every frame has one
   *  that took it, and the rest have to stand down - otherwise a click on any of
   *  them would answer a comment that is already spoken for. */
  | { do: 'disarm-others'; id: string; keep: string }
  | { do: 'restore'; draft: DraftWire; frame?: string }
  | { do: 'navigate'; page: string; frame?: string }
  | { do: 'insert-note'; ref: RefWire }
  | { do: 'banner'; text: string | null }

/** Long enough for a page that is merely slow, short enough that a page with no
 *  overlay in it does not look like a hang. */
export const ARM_TIMEOUT_MS = 1500
const MAX_RETURNS = 2

/** Every modifier a browser reads on a link is taken, so a pick cannot borrow one
 *  to pass a click *through*. It takes the modifier for itself instead. */
export function modLabel(userAgent: string): string {
  return /Mac|iP(hone|ad|od)/.test(userAgent) ? '⌘' : 'Ctrl'
}

type Result = { state: PickState | null; effects: PickEffect[] }

/** Spreads into an effect as `frame`, or into nothing when the pick is not tied
 *  to one - which is what keeps a single-preview shell's effects untargeted. */
const at = (frame: string | null): { frame?: string } => (frame ? { frame } : {})

/** Calling off the frames that were armed alongside the one that answered. A
 *  pick from the sidebar goes out to every frame at once, so ending it in one of
 *  them leaves the rest still waiting for a click that has already happened. */
function standDown(state: PickState, keep: string | null): PickEffect[] {
  return keep ? [{ do: 'disarm-others', id: state.id, keep }] : []
}

/** An event from a frame this pick has nothing to do with. Tolerates an event
 *  with no frame on it at all: that is a shell with one preview, where there is
 *  no other frame it could have come from. */
function elsewhere(state: PickState, frame: string | undefined): boolean {
  return Boolean(frame && state.frame && state.frame !== frame)
}

const done = (effects: PickEffect[]): Result => ({ state: null, effects })

/** The shell's banner is deliberately quiet while picking: the overlay is showing
 *  one inside the page, where the user is looking, and two would be noise. It
 *  speaks only for the states the in-page banner cannot express - because there
 *  is no overlay to show it, or because the page is on its way somewhere. */
function banner(state: PickState | null): PickEffect {
  if (!state) return { do: 'banner', text: null }
  if (state.phase === 'returning') {
    return { do: 'banner', text: `回到 ${state.draft?.subject?.page ?? ''} 繼續留言…` }
  }
  return { do: 'banner', text: null }
}

export function reducePick(state: PickState | null, e: PickEvent): Result {
  switch (e.t) {
    case 'arm': {
      // Already picking. The user pressed the command twice, or typed it in the
      // note box while a pick from the popup was still out.
      if (state) return { state, effects: [] }
      const next: PickState = {
        id: e.id,
        host: e.host,
        phase: 'picking',
        armed: false,
        frame: null,
        draft: null,
        ref: null,
        page: null,
        armedAt: e.now,
        returns: 0,
      }
      return {
        state: next,
        effects: [{ do: 'arm-overlay', id: e.id, host: e.host }, banner(next)],
      }
    }

    case 'armed': {
      // A pick that started in the overlay's own popup: this is the shell first
      // hearing about it, so it adopts it rather than ignoring it.
      if (!state) {
        const next: PickState = {
          id: e.id,
          host: e.host,
          phase: 'picking',
          armed: true,
          frame: e.frame ?? null,
          draft: null,
          ref: null,
          page: null,
          armedAt: e.now,
          returns: 0,
        }
        return { state: next, effects: [banner(next)] }
      }
      // A confirmation for something we are not tracking. The overlay refuses to
      // arm twice, so this can only be an echo we have already moved past.
      if (state.id !== e.id) return { state, effects: [] }
      // Deliberately not a claim on the pick. A command typed in the sidebar is
      // armed on every frame and every one of them answers; which frame it
      // belongs to is settled by where the user actually points, and until then
      // all of them have to keep listening.
      if (elsewhere(state, e.frame)) return { state, effects: [] }
      return { state: { ...state, armed: true }, effects: [] }
    }

    case 'draft':
      if (!state || state.id !== e.id || elsewhere(state, e.frame)) return { state, effects: [] }
      return { state: { ...state, draft: e.draft }, effects: [] }

    case 'picked': {
      if (!state || state.id !== e.id || elsewhere(state, e.frame)) return { state, effects: [] }
      // The answer settles the ownership a note-box pick started without.
      const owner = state.frame ?? e.frame ?? null
      if (state.host === 'note') {
        return done([{ do: 'insert-note', ref: e.ref }, ...standDown(state, owner), banner(null)])
      }
      const draft = state.draft
      // A popup-host pick with nothing to put the answer into. The overlay only
      // sends `picked` when its own popup is gone, so without a draft there is
      // nothing left that could receive this.
      if (!draft?.subject) return done([banner(null)])
      const filled = { ...draft, body: resolveDraftRef(draft.body, e.ref) }
      // Already back on the page the composer belongs to: the user walked there
      // themselves before pointing at anything.
      if (draftBelongsHere(filled, e.page)) {
        return done([{ do: 'restore', draft: filled }, banner(null)])
      }
      const next: PickState = {
        ...state,
        phase: 'returning',
        frame: owner,
        draft: filled,
        ref: e.ref,
        page: e.page,
        returns: state.returns + 1,
      }
      return {
        state: next,
        effects: [{ do: 'navigate', page: draft.subject.page, ...at(owner) }, banner(next)],
      }
    }

    case 'draft-done':
      if (!state || state.id !== e.id) return { state, effects: [] }
      return done([banner(null)])

    case 'cancelled': {
      if (!state || state.id !== e.id || elsewhere(state, e.frame)) return { state, effects: [] }
      // The overlay gave a live popup back, so its copy is the real one and ours
      // is stale. Nothing to restore, and nothing to delete: those files are
      // still chipped in a composer the user can see.
      if (e.resumed || state.host === 'note') {
        return done([...standDown(state, state.frame ?? e.frame ?? null), banner(null)])
      }
      const draft = state.draft
      if (!draft?.subject) return done([banner(null)])
      const cleared = { ...draft, body: dropDraftRef(draft.body) }
      const owner = state.frame ?? e.frame ?? null
      if (state.page && draftBelongsHere(cleared, state.page)) {
        return done([{ do: 'restore', draft: cleared, ...at(owner) }, banner(null)])
      }
      const next: PickState = {
        ...state,
        phase: 'returning',
        frame: owner,
        draft: cleared,
        ref: null,
        returns: state.returns + 1,
      }
      return {
        state: next,
        effects: [{ do: 'navigate', page: draft.subject.page, ...at(owner) }, banner(next)],
      }
    }

    case 'ready': {
      if (!state) return { state, effects: [] }
      // Every frame on a canvas reports in after a navigation, and only the one
      // the pick is out to has anything to say about it.
      if (elsewhere(state, e.frame)) return { state, effects: [] }
      const here = { ...state, page: e.page }
      if (state.phase === 'returning') {
        if (draftBelongsHere(state.draft!, e.page)) {
          return done([{ do: 'restore', draft: state.draft!, ...at(state.frame) }, banner(null)])
        }
        // The app sent us somewhere else. Try once more, then stop rather than
        // chase a redirect around forever.
        if (state.returns >= MAX_RETURNS) {
          return done([
            { do: 'banner', text: `回不到 ${state.draft?.subject?.page ?? ''}，這則留言沒有保留` },
          ])
        }
        const next = { ...here, returns: state.returns + 1 }
        return {
          state: next,
          effects: [
            { do: 'navigate', page: state.draft!.subject!.page, ...at(state.frame) },
            banner(next),
          ],
        }
      }
      // A fresh overlay in a document that never saw the pick. Re-arm it, and
      // tell it where the composer is waiting so its banner can say so. Only the
      // frame that reported: a pick still out to all of them leaves the others
      // armed exactly as they were.
      const next: PickState = { ...here, armed: false, armedAt: e.now }
      return {
        state: next,
        effects: [
          {
            do: 'arm-overlay',
            id: state.id,
            host: state.host,
            ...(state.draft?.subject ? { returnTo: state.draft.subject.page } : {}),
            ...at(e.frame ?? state.frame),
          },
          banner(next),
        ],
      }
    }

    case 'abort': {
      if (!state) return { state, effects: [] }
      // No file deletion here, deliberately. The shell cannot tell whether the
      // overlay still holds the live popup those files are chipped in, and
      // deleting them when it does would destroy what the user can still see. An
      // abandoned draft's files are what the daemon's grace window is for.
      return done([{ do: 'abort-overlay', id: state.id, ...at(state.frame) }, banner(null)])
    }

    case 'expired': {
      if (!state || state.id !== e.id || elsewhere(state, e.frame)) return { state, effects: [] }
      return done([
        { do: 'banner', text: '這則留言擱置太久，附加的檔案已經被清掉了，請重新留一次' },
      ])
    }

    case 'tick': {
      if (!state || state.armed || state.phase !== 'picking') return { state, effects: [] }
      if (e.now - state.armedAt < ARM_TIMEOUT_MS) return { state, effects: [] }
      return done([{ do: 'banner', text: '這一頁還沒準備好，沒辦法挑選元素' }])
    }
  }
}
