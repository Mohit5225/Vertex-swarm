import React, { useCallback, useEffect } from 'react'
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { ChatAttachment } from '../lib/attachments'

interface Props {
  attachments: ChatAttachment[]
  initialIndex: number
  onClose: () => void
}

const ImagePreviewModal: React.FC<Props> = ({
  attachments,
  initialIndex,
  onClose,
}) => {
  const [index, setIndex] = React.useState(initialIndex)
  const [zoom, setZoom] = React.useState(1)

  const current = attachments[index]

  const goPrev = useCallback(() => {
    setIndex((i) => (i - 1 + attachments.length) % attachments.length)
    setZoom(1)
  }, [attachments.length])

  const goNext = useCallback(() => {
    setIndex((i) => (i + 1) % attachments.length)
    setZoom(1)
  }, [attachments.length])

  useEffect(() => {
    setIndex(initialIndex)
    setZoom(1)
  }, [initialIndex])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'ArrowLeft') {
        goPrev()
      } else if (event.key === 'ArrowRight') {
        goNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goNext, goPrev, onClose])

  if (!current) {
    return null
  }

  const handleDownload = () => {
    const link = document.createElement('a')
    link.href = current.uri
    link.download = current.filename
    link.click()
  }

  return (
    <div
      className="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={onClose}
    >
      <div className="image-preview-toolbar" onClick={(e) => e.stopPropagation()}>
        <span className="image-preview-title">
          {current.filename}
          {attachments.length > 1 ? `  ${index + 1}/${attachments.length}` : ''}
        </span>
        <div className="image-preview-actions">
          <button
            type="button"
            className="image-preview-btn"
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="image-preview-btn"
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="image-preview-btn"
            onClick={handleDownload}
            title="Download"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="image-preview-btn image-preview-btn--close"
            onClick={onClose}
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {attachments.length > 1 && (
        <>
          <button
            type="button"
            className="image-preview-nav image-preview-nav--prev"
            onClick={(e) => {
              e.stopPropagation()
              goPrev()
            }}
            aria-label="Previous image"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            className="image-preview-nav image-preview-nav--next"
            onClick={(e) => {
              e.stopPropagation()
              goNext()
            }}
            aria-label="Next image"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      <div
        className="image-preview-stage"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={current.uri}
          alt={current.filename}
          className="image-preview-image"
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
        />
      </div>

      {attachments.length > 1 && (
        <div className="image-preview-strip" onClick={(e) => e.stopPropagation()}>
          {attachments.map((attachment, thumbIndex) => (
            <button
              key={attachment.id}
              type="button"
              className={`image-preview-strip-thumb ${thumbIndex === index ? 'image-preview-strip-thumb--active' : ''}`}
              onClick={() => {
                setIndex(thumbIndex)
                setZoom(1)
              }}
            >
              <img src={attachment.uri} alt={attachment.filename} draggable={false} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default ImagePreviewModal
