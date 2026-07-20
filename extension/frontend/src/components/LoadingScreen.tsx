import React from 'react'
import VertexLogo from './VertexLogo'

const LoadingScreen: React.FC = () => {
  return (
    <div className="loading-screen" role="status" aria-label="Loading Vertex Swarm">
      <VertexLogo className="loading-logo" animated />
    </div>
  )
}

export default LoadingScreen
