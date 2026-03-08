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
      <div className="w-full max-w-sm rounded-[22px] border border-white/8 bg-[#0d1424]/96 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#7d89a6]">
          Session
        </p>
        <h2 className="text-lg font-semibold tracking-tight text-white">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#95a2bd]">{description}</p>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="ghost-btn">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="primary-btn !bg-[#f27d75] !text-[#160b0b] hover:!shadow-[0_10px_30px_rgba(242,125,117,0.22)]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
