import React, { useEffect } from 'react'
import { useAuthStore } from './store/authStore'
import LoginPanel from './components/LoginPanel'
import ChatPanel from './components/ChatPanel'

const App: React.FC = () => {
  const { isAuthenticated, loading, initializeExtensionBridge } = useAuthStore()

  useEffect(() => {
    initializeExtensionBridge()
  }, [initializeExtensionBridge])

  return (
    <div className="app-shell">
      {loading ? (
        <div className="flex h-full items-center justify-center px-4 py-6 md:px-5">
          <div className="w-full max-w-md">
            <p className="surface-label">Vertex Swarm</p>
            <h1 className="mt-3 text-[1.7rem] font-semibold leading-tight text-white">
              Restoring session...
            </h1>
            <p className="mt-3 text-sm leading-7 text-[#92a0bb]">
              Checking the extension session before we render the sidebar.
            </p>
          </div>
        </div>
      ) : isAuthenticated ? (
        <ChatPanel />
      ) : (
        <LoginPanel />
      )}
    </div>
  )
}

export default App
