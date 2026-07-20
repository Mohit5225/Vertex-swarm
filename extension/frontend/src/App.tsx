import React, { useEffect } from 'react'
import { useConfigStore } from './store/configStore'
import SettingsPanel from './components/SettingsPanel'
import ChatPanel from './components/ChatPanel'
import LoginPanel from './components/LoginPanel'
import LoadingScreen from './components/LoadingScreen'

const App: React.FC = () => {
  const {
    hasConfig,
    isAuthenticated,
    isEditingProvider,
    loading,
    initializeExtensionBridge,
  } = useConfigStore()

  useEffect(() => {
    initializeExtensionBridge()
  }, [initializeExtensionBridge])

  return (
    <div className="app-shell">
      {loading ? (
        <LoadingScreen />
      ) : !isAuthenticated ? (
        <LoginPanel />
      ) : !hasConfig || isEditingProvider ? (
        <SettingsPanel />
      ) : (
        <ChatPanel />
      )}
    </div>
  )
}

export default App
