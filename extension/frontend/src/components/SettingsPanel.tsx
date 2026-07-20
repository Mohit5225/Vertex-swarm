import React, { useState } from 'react'
import { getVsCodeApi } from '../lib/vscode'
import { useConfigStore } from '../store/configStore'

const SettingsPanel: React.FC = () => {
  const { error, logout, config, hasConfig, isEditingProvider, closeProviderSettings } =
    useConfigStore()
  const [llmBaseUrl, setLlmBaseUrl] = useState(
    config?.llmBaseUrl || 'https://api.deepseek.com/v1',
  )
  const [llmModel, setLlmModel] = useState(config?.llmModel || 'deepseek-chat')
  const [llmKey, setLlmKey] = useState('')
  const [exaKey, setExaKey] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  React.useEffect(() => {
    if (config?.llmBaseUrl) {
      setLlmBaseUrl(config.llmBaseUrl)
    }
    if (config?.llmModel) {
      setLlmModel(config.llmModel)
    }
  }, [config?.llmBaseUrl, config?.llmModel])

  React.useEffect(() => {
    if (error) {
      setIsSubmitting(false)
    }
  }, [error])

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    getVsCodeApi()?.postMessage({
      type: 'save-config',
      payload: {
        llmBaseUrl,
        llmModel,
        ...(llmKey.trim() ? { llmKey } : {}),
        ...(exaKey.trim() ? { exaKey } : {}),
      },
    })
    // Will wait for backend initialization message from extension
  }

  return (
    <div className="flex h-full items-center justify-center px-4 py-6 md:px-5">
      <div className="w-full max-w-md">
        <p className="surface-label">Vertex Swarm</p>
        <h1 className="mt-3 max-w-[18rem] text-[1.7rem] font-semibold leading-tight text-white">
          {isEditingProvider ? 'Reconfigure Provider' : 'Configure Provider'}
        </h1>
        <p className="mt-3 text-sm leading-7 text-[#92a0bb]">
          {isEditingProvider
            ? 'Update your LLM endpoint or keys. Leave key fields blank to keep the stored values.'
            : 'Provide your local or cloud LLM endpoint and keys to start the agent. Keys are stored securely in your OS keychain.'}
        </p>

        {error && (
          <div className="mt-5 border-l-2 border-[#f27d75] pl-3 text-sm leading-6 text-[#ffbeb8]">
            {error}
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#d4d4d4]">LLM Base URL</label>
            <input 
              type="text" 
              value={llmBaseUrl} 
              onChange={e => setLlmBaseUrl(e.target.value)} 
              className="px-3 py-2 bg-[#1e1e1e] border border-[#3c3c3c] rounded text-white focus:outline-none focus:border-[#007acc]"
              placeholder="https://api.deepseek.com/v1"
            />
          </div>
          
          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#d4d4d4]">LLM Model</label>
            <input 
              type="text" 
              value={llmModel} 
              onChange={e => setLlmModel(e.target.value)} 
              className="px-3 py-2 bg-[#1e1e1e] border border-[#3c3c3c] rounded text-white focus:outline-none focus:border-[#007acc]"
              placeholder="deepseek-chat"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#d4d4d4]">LLM API Key</label>
            <input 
              type="password" 
              value={llmKey} 
              onChange={e => setLlmKey(e.target.value)} 
              className="px-3 py-2 bg-[#1e1e1e] border border-[#3c3c3c] rounded text-white focus:outline-none focus:border-[#007acc]"
              placeholder={isEditingProvider ? 'Leave blank to keep current key' : 'sk-...'}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#d4d4d4]">Exa API Key (Optional)</label>
            <input 
              type="password" 
              value={exaKey} 
              onChange={e => setExaKey(e.target.value)} 
              className="px-3 py-2 bg-[#1e1e1e] border border-[#3c3c3c] rounded text-white focus:outline-none focus:border-[#007acc]"
            />
          </div>

          <button
            type="submit"
            disabled={
              isSubmitting ||
              !llmBaseUrl ||
              !llmModel ||
              (!hasConfig && !llmKey)
            }
            className="mt-2 primary-btn w-full justify-center disabled:opacity-50"
          >
            {isSubmitting
              ? 'Saving...'
              : isEditingProvider
                ? 'Save changes'
                : 'Start Agent'}
          </button>

          {isEditingProvider ? (
            <button
              type="button"
              onClick={closeProviderSettings}
              className="ghost-btn mt-1 w-full justify-center"
            >
              Back to chat
            </button>
          ) : (
            <button
              type="button"
              onClick={logout}
              className="ghost-btn mt-1 w-full justify-center"
            >
              Sign out
            </button>
          )}
        </form>
      </div>
    </div>
  )
}

export default SettingsPanel
