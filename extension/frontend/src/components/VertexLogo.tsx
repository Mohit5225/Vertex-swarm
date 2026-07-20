import React, { useId } from 'react'

interface VertexLogoProps {
  className?: string
  animated?: boolean
}

const VertexLogo: React.FC<VertexLogoProps> = ({
  className = 'h-9 w-9',
  animated = false,
}) => {
  const gradientId = useId().replace(/:/g, '')

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {animated ? (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="2"
            y1="2"
            x2="22"
            y2="22"
          >
            <stop offset="0%" stopColor="#8a8268" stopOpacity="0.55" />
            <stop offset="38%" stopColor="#c9bf9f" />
            <stop offset="50%" stopColor="#fff9e8" />
            <stop offset="62%" stopColor="#c9bf9f" />
            <stop offset="100%" stopColor="#8a8268" stopOpacity="0.55" />
            <animate
              attributeName="x1"
              values="-8;28;-8"
              dur="2.4s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="y1"
              values="-8;28;-8"
              dur="2.4s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="x2"
              values="4;40;4"
              dur="2.4s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="y2"
              values="4;40;4"
              dur="2.4s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
      ) : null}
      <polygon
        points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"
        stroke={animated ? `url(#${gradientId})` : '#d8cdb0'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default VertexLogo
