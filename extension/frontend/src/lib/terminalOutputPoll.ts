import { getVsCodeApi } from './vscode'

export interface TerminalOutputPollResult {
  content: string
  totalChars?: number
  status?: string
}

export const requestTerminalOutput = (jobId: string, timeoutMs = 4000) =>
  new Promise<TerminalOutputPollResult>((resolve) => {
    const handler = (event: MessageEvent) => {
      const message = event.data as {
        type?: string
        payload?: {
          jobId?: string
          content?: string
          totalChars?: number
          status?: string
        }
      }

      if (message?.type !== 'terminal-output' || message.payload?.jobId !== jobId) {
        return
      }

      window.removeEventListener('message', handler)
      clearTimeout(timeout)
      resolve({
        content: message.payload.content || '',
        totalChars: message.payload.totalChars,
        status: message.payload.status,
      })
    }

    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve({ content: '' })
    }, timeoutMs)

    window.addEventListener('message', handler)
    getVsCodeApi()?.postMessage({
      type: 'get-terminal-output',
      payload: { jobId },
    })
  })
