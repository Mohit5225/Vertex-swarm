import React, { useState } from 'react'
import { getVsCodeApi } from '../lib/vscode'
import { useAuthStore } from '../store/authStore'

const LoginPanel: React.FC = () => {
  const [copied, setCopied] = useState(false)
  const { error } = useAuthStore()

  const handleOpenBrowser = () => {
    getVsCodeApi()?.postMessage({ type: 'open-browser' })
  }

  const handleCopyLink = async () => {
    getVsCodeApi()?.postMessage({ type: 'copy-link' })
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full items-center justify-center px-4 py-6 md:px-5">
      <div className="w-full max-w-md">
        <p className="surface-label">Vertex Swarm</p>
        <h1 className="mt-3 max-w-[18rem] text-[1.7rem] font-semibold leading-tight text-white">
          Sign in to open the agent.
        </h1>
        <p className="mt-3 max-w-[24rem] text-sm leading-7 text-[#92a0bb]">
          The session is stored locally in the extension. Vertex Swarm refreshes
          the backend JWT automatically while the Neon session is still valid.
        </p>

        {error && (
          <div className="mt-5 border-l-2 border-[#f27d75] pl-3 text-sm leading-6 text-[#ffbeb8]">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 min-[420px]:flex-row">
          <button
            type="button"
            onClick={handleOpenBrowser}
            className="primary-btn w-full justify-center"
          >
            Open browser sign-in
          </button>

          <button
            type="button"
            onClick={handleCopyLink}
            className="ghost-btn w-full justify-center"
          >
            {copied ? 'Link copied' : 'Copy sign-in link'}
          </button>
        </div>

        <p className="mt-4 text-[12px] leading-6 text-[#7383a1]">
          Stored locally / Browser account chooser / automatic JWT refresh
        </p>
      </div>
    </div>
  )
}

export default LoginPanel
