import * as THREE from 'three'

/** Set by the viewer so UI outside the Canvas can grab frames and export geometry. */
export const rendererRef: { current: THREE.WebGLRenderer | null } = { current: null }

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function captureScreenshot(filename: string): boolean {
  const gl = rendererRef.current
  if (!gl) return false
  gl.domElement.toBlob((blob) => {
    if (blob) downloadBlob(blob, filename)
  }, 'image/png')
  return true
}
