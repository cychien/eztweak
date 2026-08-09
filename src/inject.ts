import { URL_PREFIX } from './constants.js'

const SNIPPET =
  `<link rel="stylesheet" href="${URL_PREFIX}/overlay.css">` +
  `<script defer src="${URL_PREFIX}/overlay.js"></script>`

/** Inject the overlay assets into proxied HTML. Idempotent. */
export function injectOverlay(html: string): string {
  if (html.includes(`${URL_PREFIX}/overlay.js`)) return html
  const head = html.match(/<head[^>]*>/i)
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length
    return html.slice(0, at) + SNIPPET + html.slice(at)
  }
  const body = html.match(/<body[^>]*>/i)
  if (body && body.index !== undefined) {
    const at = body.index + body[0].length
    return html.slice(0, at) + SNIPPET + html.slice(at)
  }
  return SNIPPET + html
}

/** True when the request is for a navigable HTML document (worth intercepting). */
export function wantsHtml(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.includes('text/html')
}
