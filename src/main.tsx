import { createRoot } from 'react-dom/client'
import App from './App'
// The page shell first, then the builder's own styles. Only this entry point loads
// page.css — an embedding host owns its own body and must not have it rewritten.
import './page.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
