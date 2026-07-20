import React from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#04060d]/70 px-4 pb-6 pt-10 backdrop-blur-sm sm:items-center">
      <div className="popover-panel w-full max-w-sm p-1.5">
        <div className="px-3 py-2.5">
          <p className="popover-eyebrow">Session</p>
          <h2 className="popover-title">{title}</h2>
          <p className="mt-1.5 text-[13px] leading-6 text-[#7f91b4]">
            {description}
          </p>
        </div>

        <div className="popover-divider" />

        <div className="flex items-center justify-end gap-2 px-1.5 py-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-[15px] text-[#e6ecfa] transition hover:bg-white/[0.06]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-[#f27d75]/15 px-3 py-2 text-[15px] font-medium text-[#f0a8a2] transition hover:bg-[#f27d75]/25"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
