/** Which recurring questions the user has told the review to stop asking.
 *
 *  Per viewer and per browser, like the rest of the shell's preferences: this is
 *  a choice about being interrupted, not state anything else depends on.
 *
 *  The one rule with any weight in it is that **only a yes is remembered**. A
 *  "stop asking" that could remember a no would be a control that silently
 *  refuses the thing it was asked about, for good, with nothing on screen to say
 *  why - and the way back would be a storage key no user is ever going to find. */

/** The slice of `localStorage` this needs, so the rule can be tested without a
 *  browser - and so a store that throws is a case rather than a crash. */
export interface KeyStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function confirmSkipKey(question: string): string {
  return `ez-confirm-skip:${question}`
}

/** Whether this question has been put away. Anything but a stored yes means ask,
 *  including a store that will not answer: silence is not consent. */
export function confirmSkipped(store: KeyStore | null, question: string): boolean {
  try {
    return store?.getItem(confirmSkipKey(question)) === '1'
  } catch {
    return false
  }
}

/** Record the answer, if it is the kind that can be recorded. */
export function rememberConfirm(
  store: KeyStore | null,
  question: string,
  answer: { ok: boolean; skip: boolean },
): void {
  if (!answer.ok || !answer.skip) return
  try {
    store?.setItem(confirmSkipKey(question), '1')
  } catch {
    /* the question simply gets asked again next time */
  }
}
