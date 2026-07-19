import React from 'react'
import type { FileChange } from '../lib/fileChangeTypes'
import {
  binaryChangeStats,
  shouldShowBinaryStats,
  shouldShowLineStats,
} from '../lib/fileChangeStats'

export const ChangeStatBadges: React.FC<{ change: FileChange }> = ({ change }) => {
  const binaryStats = binaryChangeStats(change)

  return (
    <>
      {shouldShowBinaryStats(change) ? (
        <>
          {binaryStats.added ? (
            <span className="text-[10px] font-mono text-[#2dd4bf]">+{binaryStats.added}</span>
          ) : null}
          {binaryStats.removed ? (
            <span className="text-[10px] font-mono text-[#f43f5e]">-{binaryStats.removed}</span>
          ) : null}
        </>
      ) : null}
      {shouldShowLineStats(change) ? (
        <>
          <span className="text-[10px] font-mono text-[#2dd4bf]">+{change.additions}</span>
          <span className="text-[10px] font-mono text-[#f43f5e]">-{change.deletions}</span>
        </>
      ) : null}
    </>
  )
}
