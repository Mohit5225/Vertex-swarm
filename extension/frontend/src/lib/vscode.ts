type VSCodeApi = {
  postMessage: (message: unknown) => void
  getState?: () => unknown
  setState?: (state: unknown) => void
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VSCodeApi
    __vertexSwarmVsCodeApi?: VSCodeApi
  }
}

let cachedVsCodeApi: VSCodeApi | null = null

export const getVsCodeApi = (): VSCodeApi | null => {
  if (cachedVsCodeApi) {
    return cachedVsCodeApi
  }

  if (typeof window === 'undefined') {
    return null
  }

  if (window.__vertexSwarmVsCodeApi) {
    cachedVsCodeApi = window.__vertexSwarmVsCodeApi
    return cachedVsCodeApi
  }

  if (typeof window.acquireVsCodeApi !== 'function') {
    return null
  }

  cachedVsCodeApi = window.acquireVsCodeApi()
  window.__vertexSwarmVsCodeApi = cachedVsCodeApi
  return cachedVsCodeApi
}
