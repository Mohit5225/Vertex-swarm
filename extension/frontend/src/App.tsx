import React, { useEffect } from 'react'
import { useConfigStore } from './store/configStore'
import SettingsPanel from './components/SettingsPanel'
import ChatPanel from './components/ChatPanel'
import LoginPanel from './components/LoginPanel'

const App: React.FC = () => {
  const { hasConfig, isAuthenticated, loading, initializeExtensionBridge } = useConfigStore()

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
              Checking Configuration...
            </h1>
            <p className="mt-3 text-sm leading-7 text-[#92a0bb]">
              Ensuring backend is connected.
            </p>
          </div>
        </div>
      ) : !isAuthenticated ? (
        <LoginPanel />
      ) : !hasConfig ? (
        <SettingsPanel />
      ) : (
        <ChatPanel />
      )}
    </div>
  )
}

export default App
