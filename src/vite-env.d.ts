/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENTOPO_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
