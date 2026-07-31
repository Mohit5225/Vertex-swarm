import React from 'react'
import { X } from 'lucide-react'
import type { ChatAttachment } from '../lib/attachments'

interface Props {
  attachments: ChatAttachment[]
  onPreview: (index: number) => void
  onRemove?: (id: string) => void
  size?: 'composer' | 'message'
}

const AttachmentThumbnails: React.FC<Props> = ({
  attachments,
  onPreview,
  onRemove,
  size = 'composer',
}) => {
  if (attachments.length === 0) {
    return null
  }

  const sizeClass =
    size === 'message' ? 'attachment-thumb--message' : 'attachment-thumb--composer'

  return (
    <div className={`attachment-thumb-row ${size === 'message' ? 'attachment-thumb-row--message' : ''}`}>
      {attachments.map((attachment, index) => (
        <div key={attachment.id} className={`attachment-thumb-wrap ${sizeClass}`}>
          <button
            type="button"
            className="attachment-thumb"
            onClick={() => onPreview(index)}
            title={attachment.filename}
          >
            <img src={attachment.uri} alt={attachment.filename} draggable={false} />
          </button>
          {onRemove && (
            <button
              type="button"
              className="attachment-thumb-remove"
              onClick={(event) => {
                event.stopPropagation()
                onRemove(attachment.id)
              }}
              title="Remove"
              aria-label={`Remove ${attachment.filename}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default AttachmentThumbnails
