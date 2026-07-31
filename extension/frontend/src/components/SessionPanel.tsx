import React from 'react'
import { ChevronRight, LogOut, Plus, Settings2 } from 'lucide-react'
import type { VertexConfig } from '../store/configStore'
import type { ContextPolicyData } from '../lib/contextPolicyTypes'
import ContextPolicySection from './ContextPolicySection'

const RETENTION_DAYS = [1, 2, 3, 4, 5, 6, 7] as const

interface SessionPanelProps {
  panelRef: React.RefObject<HTMLDivElement>
  config: VertexConfig | null
  isStreaming: boolean
  hasMessages: boolean
  snapshotRetentionDays: number
  contextPolicy: ContextPolicyData
  onSnapshotRetentionChange: (days: number) => void
  onContextPolicyChange: (policy: ContextPolicyData) => void
  onNewTask: () => void
  onReconfigure: () => void
  onSignOut: () => void
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  panelRef,
  config,
  isStreaming,
  hasMessages,
  snapshotRetentionDays,
  contextPolicy,
  onSnapshotRetentionChange,
  onContextPolicyChange,
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
      <div className="provider-card">
        <p className="provider-card-host">{providerHost}</p>
        <p className="provider-card-model">{config?.llmModel || 'Default model'}</p>
      </div>

      <div className="popover-divider" />

      <div className="popover-section">
        <p className="popover-section-label">Keep snapshots for</p>
        <div className="retention-chips" role="group" aria-label="Snapshot retention in days">
          {RETENTION_DAYS.map((days) => {
            const isActive = snapshotRetentionDays === days
            return (
              <button
                key={days}
                type="button"
                aria-pressed={isActive}
                onClick={() => onSnapshotRetentionChange(days)}
                className={`retention-chip ${isActive ? 'retention-chip--active' : ''}`}
              >
                {days}d
              </button>
            )
          })}
        </div>
      </div>

      <div className="popover-divider" />

      <ContextPolicySection
        policy={contextPolicy}
        onChange={onContextPolicyChange}
      />

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
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--vs-text-tertiary)]" aria-hidden="true" />
      </button>

      <div className="popover-divider" />

      <button type="button" onClick={onSignOut} className="popover-row danger-text">
        <span className="popover-row-icon !text-[var(--vs-danger)]">
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="popover-row-title">Sign out</span>
      </button>
    </div>
  )
}

export default SessionPanel
