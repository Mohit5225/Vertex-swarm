import React from 'react'
import {
  ChevronRight,
  KeyRound,
  LogOut,
  Plus,
  Settings2,
  Sparkles,
} from 'lucide-react'
import type { VertexConfig } from '../store/configStore'

interface SessionPanelProps {
  panelRef: React.RefObject<HTMLDivElement>
  config: VertexConfig | null
  userEmail?: string
  sessionState: 'running' | 'ready' | 'idle'
  isStreaming: boolean
  hasMessages: boolean
  snapshotRetentionDays: number
  onSnapshotRetentionChange: (days: number) => void
  onNewTask: () => void
  onReconfigure: () => void
  onSignOut: () => void
}

const statusCopy = {
  running: 'Running',
  ready: 'Ready',
  idle: 'Idle',
} as const

const SessionPanel: React.FC<SessionPanelProps> = ({
  panelRef,
  config,
  userEmail,
  sessionState,
  isStreaming,
  hasMessages,
  snapshotRetentionDays,
  onSnapshotRetentionChange,
  onNewTask,
  onReconfigure,
  onSignOut,
}) => {
  const providerHost = React.useMemo(() => {
    if (!config?.llmBaseUrl) {
      return 'Local provider'
    }

    try {
      return new URL(config.llmBaseUrl).hostname
    } catch {
      return config.llmBaseUrl
    }
  }, [config?.llmBaseUrl])

  return (
    <div ref={panelRef} className="session-panel">
      <div className="popover-header">
        <div>
          <p className="popover-eyebrow">Vertex Swarm</p>
          <p className="popover-title">Session</p>
        </div>
        <span className={`session-status session-status--${sessionState}`}>
          {sessionState === 'running' ? (
            <span className="session-status-dot" aria-hidden="true" />
          ) : null}
          {statusCopy[sessionState]}
        </span>
      </div>

      <div className="popover-divider" />

      <div className="popover-row">
        <span className="popover-row-icon">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="popover-row-copy">
          <span className="popover-row-title">{providerHost}</span>
          <span className="popover-row-subtitle">
            {config?.llmModel || 'Default model'}
            <span className="mx-1.5 text-white/15">·</span>
            <KeyRound className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
            Keychain
          </span>
          {userEmail ? (
            <span className="popover-row-subtitle mt-1 block truncate">
              {userEmail}
            </span>
          ) : null}
        </span>
      </div>

      <div className="popover-divider" />

      <div className="popover-section">
        <div className="flex items-center justify-between gap-3">
          <p className="popover-section-label">Snapshot retention</p>
          <span className="text-[12px] font-mono text-[#7f91b4]">
            {snapshotRetentionDays}d
          </span>
        </div>
        <input
          type="range"
          min="1"
          max="7"
          value={snapshotRetentionDays}
          onChange={(event) => {
            onSnapshotRetentionChange(parseInt(event.target.value, 10))
          }}
          className="session-retention-slider"
          aria-label="Snapshot retention in days"
        />
        <div className="session-retention-scale" aria-hidden="true">
          <span>1 day</span>
          <span>7 days</span>
        </div>
      </div>

      {hasMessages ? (
        <>
          <div className="popover-divider" />
          <button
            type="button"
            onClick={onNewTask}
            disabled={isStreaming}
            className="popover-row"
          >
            <span className="popover-row-icon">
              <Plus className="h-4 w-4" />
            </span>
            <span className="popover-row-copy">
              <span className="popover-row-title">New task</span>
              <span className="popover-row-subtitle">
                Clear the thread and start fresh
              </span>
            </span>
          </button>
        </>
      ) : null}

      <div className="popover-divider" />

      <button type="button" onClick={onReconfigure} className="popover-row">
        <span className="popover-row-icon">
          <Settings2 className="h-4 w-4" />
        </span>
        <span className="popover-row-copy">
          <span className="popover-row-title">Reconfigure provider</span>
          <span className="popover-row-subtitle">
            Change model, endpoint, or API keys
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#6e7f9d]" aria-hidden="true" />
      </button>

      <div className="popover-divider" />

      <button type="button" onClick={onSignOut} className="popover-row text-[#f0a8a2]">
        <span className="popover-row-icon !text-[#f0a8a2]">
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="popover-row-title">Sign out</span>
      </button>
    </div>
  )
}

export default SessionPanel
