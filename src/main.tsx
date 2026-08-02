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
import { Builder } from '@groundwork/builder'
import '@groundwork/builder/styles.css'
import './page.css'

createRoot(document.getElementById('root')!).render(<Builder />)
