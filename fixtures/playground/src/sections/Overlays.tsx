import { useRef, useState } from 'react'

/** Content that only exists while something is open.
 *
 *  Here for one reason: it is the case an explore has to survive. A variant
 *  standing in for something inside a dialog has to still be there after the
 *  dialog is closed and opened again - and the element it stood in for is a
 *  different DOM node each time, because React unmounts the subtree. Nothing
 *  else in this fixture remounts, so without this the interesting half of the
 *  swap is untested.
 *
 *  Both are the platform's own - `<dialog>` and the popover attribute - rather
 *  than a component library, because what is being tested is remounting, not
 *  anyone's implementation of a modal. */
export function Overlays() {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)

  return (
    <section className="overlays" data-section="overlays">
      <div className="shell">
        <h2>開啟後才存在的內容</h2>
        <p className="overlays-lead">
          這兩塊內容關掉就從 DOM 消失，重開是新的節點。探索的 variant 要能跟著回來。
        </p>
        <div className="overlays-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              dialog.current?.showModal()
              setOpen(true)
            }}
          >
            開啟對話框
          </button>
          <button type="button" className="btn" popoverTarget="plan-popover">
            開啟 popover
          </button>
        </div>

        <dialog
          ref={dialog}
          className="overlay-dialog"
          onClose={() => setOpen(false)}
          aria-labelledby="overlay-dialog-title"
        >
          {open && (
            <div className="overlay-dialog-body">
              <h3 id="overlay-dialog-title">升級到 Team</h3>
              <p className="overlay-dialog-copy">
                Team 方案可以跨組看見彼此的進度，並在項目連續兩週沒有動靜時自動標記。
              </p>
              <button type="button" className="btn btn-primary overlay-dialog-cta">
                升級方案
              </button>
              <button type="button" className="btn" onClick={() => dialog.current?.close()}>
                稍後再說
              </button>
            </div>
          )}
        </dialog>

        <div id="plan-popover" popover="auto" className="overlay-popover">
          <h3 className="overlay-popover-title">這週的重點</h3>
          <p className="overlay-popover-copy">結帳流程改版已上線，Webhook 重送機制卡了三天。</p>
          <span className="overlay-popover-tag">需要決定</span>
        </div>
      </div>
    </section>
  )
}
