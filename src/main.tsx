/**
 * The standalone Groundwork app — a thin shell around the builder package.
 *
 * Everything here is what a *page* owns rather than what the builder owns: the root
 * element, the body reset, and the decision to fill the viewport. A host embedding
 * `<Builder />` supplies its own equivalents and loads none of this.
 *
 * That it is this short is the point. If something has to be added here to make the
 * builder work, it probably belongs inside the package instead.
 */
import { createRoot } from 'react-dom/client'
import { Builder } from '@dharv44/groundwork-builder'
import '@dharv44/groundwork-builder/styles.css'
import './page.css'

// TEMPORARY diagnostic — remove once the update-depth loop is found.
//
// A "Maximum update depth exceeded" loop is being reported in the user-visible
// window, which mounts the R3F canvas; the tooling-visible tab is hidden, never
// mounts it, and so can never reproduce. React prints the guilty component stack to
// the console of the window it happens in — this stashes it in localStorage, which
// both windows share, so the stack can be read from the other side.
if (import.meta.env.DEV) {
  const origError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      const text = args.map((a) => (a instanceof Error ? a.stack : String(a))).join('\n')
      if (/Maximum update depth/i.test(text)) {
        localStorage.setItem('gw.updateDepthTrap', JSON.stringify({ at: Date.now(), text }))
      }
    } catch {
      /* the trap must never break the app */
    }
    origError(...args)
  }
  window.addEventListener('error', (e) => {
    if (/Maximum update depth/i.test(String(e.error?.stack ?? e.message))) {
      localStorage.setItem(
        'gw.updateDepthTrap.window',
        JSON.stringify({ at: Date.now(), text: String(e.error?.stack ?? e.message) }),
      )
    }
  })
}

createRoot(document.getElementById('root')!).render(<Builder />)
