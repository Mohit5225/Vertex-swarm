import React from 'react'
import type { FileChange } from '../lib/fileChangeTypes'
import { DIFF_ADD_COLOR, DIFF_DEL_COLOR } from '../lib/diffColors'
import {
  binaryChangeStats,
  shouldShowBinaryStats,
  shouldShowLineStats,
} from '../lib/fileChangeStats'

const addStyle = { color: DIFF_ADD_COLOR }
const delStyle = { color: DIFF_DEL_COLOR }

export const ChangeStatBadges: React.FC<{ change: FileChange }> = ({ change }) => {
  const binaryStats = binaryChangeStats(change)

  return (
    <>
      {shouldShowBinaryStats(change) ? (
        <>
          {binaryStats.added ? (
            <span className="text-[10px] font-mono tabular-nums" style={addStyle}>+{binaryStats.added}</span>
          ) : null}
          {binaryStats.removed ? (
            <span className="text-[10px] font-mono tabular-nums" style={delStyle}>-{binaryStats.removed}</span>
          ) : null}
        </>
      ) : null}
      {shouldShowLineStats(change) ? (
        <>
          <span className="text-[10px] font-mono tabular-nums" style={addStyle}>+{change.additions}</span>
          <span className="text-[10px] font-mono tabular-nums" style={delStyle}>-{change.deletions}</span>
        </>
      ) : null}
    </>
  )
}
