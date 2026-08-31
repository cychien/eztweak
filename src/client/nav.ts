/** Who owns the review's session history.
 *
 *  A preview is an iframe, and an iframe that navigates writes an entry into the
 *  joint session history that only that iframe can answer for. The shell throws
 *  its frames away whenever the stage is rebuilt - one device to all of them and
 *  back again - so those entries outlive the documents behind them: back lands
 *  on an entry nobody can honour, the review does not move, and one more press
 *  leaves the shell altogether.
 *
 *  So the previews keep no history of their own. Everything that would have
 *  pushed an entry inside one is caught by the overlay and handed up here, the
 *  shell pushes the entry in its own document, and every frame is pointed at the
 *  page with `location.replace`. Back is then a `popstate` the shell can always
 *  answer, whatever has been mounted or thrown away since.
 *
 *  A pure reducer, like the pick transaction: the shell's tests have no DOM. */

export interface NavState {
  /** Relative URL - path, query and hash - every preview is pointed at. */
  url: string
}

export type NavEvent =
  /** A document navigation the overlay took off the page before the browser
   *  could act on it. The only kind that has not happened yet. */
  | { t: 'request'; url: string }
  /** A client-side route change, already applied inside `from`. Nothing was
   *  pushed for it: the overlay turns the app's `pushState` into a
   *  `replaceState` on the way through. */
  | { t: 'moved'; url: string; from: string }
  /** A preview finished loading. Anywhere other than where it was sent means a
   *  navigation the overlay could not catch - a form submit, the app assigning
   *  `location` - and that one pushed an entry of its own, so the page is
   *  recorded rather than pushed on top of. */
  | { t: 'loaded'; url: string; from: string }
  /** The browser moved through the shell's own history. */
  | { t: 'pop'; url: string }

export type NavEffect =
  | { do: 'push'; url: string }
  | { do: 'replace'; url: string }
  /** `except` names the frame that is already there. */
  | { do: 'navigate'; url: string; except?: string }

type Result = { state: NavState; effects: NavEffect[] }

export function reduceNav(state: NavState, e: NavEvent): Result {
  switch (e.t) {
    case 'request': {
      // A link to the page already open is a reload, not somewhere to come back
      // to: every frame is sent again, and no entry is pushed for it.
      const push: NavEffect[] = e.url === state.url ? [] : [{ do: 'push', url: e.url }]
      return { state: { url: e.url }, effects: [...push, { do: 'navigate', url: e.url }] }
    }
    case 'moved':
      if (e.url === state.url) return { state, effects: [] }
      return {
        state: { url: e.url },
        effects: [
          { do: 'push', url: e.url },
          { do: 'navigate', url: e.url, except: e.from },
        ],
      }
    case 'loaded':
      if (e.url === state.url) return { state, effects: [] }
      return {
        state: { url: e.url },
        effects: [
          { do: 'replace', url: e.url },
          { do: 'navigate', url: e.url, except: e.from },
        ],
      }
    case 'pop':
      // The browser has already moved; only the previews are behind.
      if (e.url === state.url) return { state, effects: [] }
      return { state: { url: e.url }, effects: [{ do: 'navigate', url: e.url }] }
  }
}
