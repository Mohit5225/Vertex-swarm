import React, { useEffect, useRef } from 'react'
import { useAuthStore } from './store/authStore'
import LoginPanel from './components/LoginPanel'
import ChatPanel from './components/ChatPanel'

const App: React.FC = () => {
  const { isAuthenticated, initializeExtensionBridge } = useAuthStore()
  const extensionBridgeInitialized = useRef(false)

  useEffect(() => {
    if (!extensionBridgeInitialized.current) {
      extensionBridgeInitialized.current = true
      initializeExtensionBridge()
    }
  }, [initializeExtensionBridge])

  return (
    <div className="app-shell">
      {isAuthenticated ? <ChatPanel /> : <LoginPanel />}
    </div>
  )
}

export default App
