import React from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  userEmail?: string
  onConfirm: () => void
  onCancel: () => void
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  userEmail,
  onConfirm,
  onCancel,
}) => {
  if (!open) {
    return null
  }

  return (
    <div
      className="confirm-overlay"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 py-4">
          <h2 id="confirm-dialog-title" className="popover-title">
            {title}
          </h2>
          {userEmail ? (
            <p className="mt-2 truncate text-[14px] text-[var(--vs-text-primary)]">
              {userEmail}
            </p>
          ) : null}
          <p className="mt-2 text-[13px] leading-6 text-[var(--vs-text-secondary)]">
            {description}
          </p>
        </div>

        <div className="popover-divider" />

        <div className="flex items-center justify-end gap-2 px-2 py-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-[15px] text-[var(--vs-text-primary)] transition hover:bg-[var(--vs-accent-muted)]"
          >
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className="danger-btn">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
