import React from 'react';
import { Undo2, Search, Files } from 'lucide-react';
import { getVsCodeApi } from '../lib/vscode';
import { DIFF_ADD_COLOR, DIFF_DEL_COLOR } from '../lib/diffColors';
import { FileExtensionIcon } from '../lib/fileExtensionIcon';
import {
  canUndoChange,
  fileChangeDetail,
  summarizeFileChanges,
  binaryChangeStats,
} from '../lib/fileChangeStats';
import { buildReviewPayload, canReviewChange } from '../lib/reviewPayload';
import type { FileChange, FileChangeOperation } from '../lib/fileChangeTypes';
import { ChangeStatBadges } from './ChangeStatBadges';

export type { FileChange, FileChangeOperation };

interface FileChangesCardProps {
  snapshotId: string;
  sessionId: string;
  messageId: string;
  changes: FileChange[];
  isHistorical?: boolean;
}

export const FileChangesCard: React.FC<FileChangesCardProps> = ({
  snapshotId,
  sessionId,
  messageId,
  changes,
  isHistorical,
}) => {
  const totalAdditions = changes.reduce((acc, change) => acc + (change.isBinary ? 0 : change.additions), 0);
  const totalDeletions = changes.reduce((acc, change) => acc + (change.isBinary ? 0 : change.deletions), 0);
  const hasTextStats = totalAdditions > 0 || totalDeletions > 0;
  const hasBinaryStats = changes.some((change) => Boolean(binaryChangeStats(change).added || binaryChangeStats(change).removed));
  const hasUndoableChanges = changes.some(canUndoChange);

  const handleUndo = () => {
    getVsCodeApi()?.postMessage({
      type: 'undo-snapshot',
      payload: { snapshotId, sessionId, messageId },
    });
  };

  const handleReview = () => {
    const firstReviewable = changes.find(canReviewChange);
    const payload = firstReviewable ? buildReviewPayload(firstReviewable) : null;
    if (!payload) {
      return;
    }

    getVsCodeApi()?.postMessage({
      type: 'review-snapshot',
      payload,
    });
  };

  const handleReviewFile = (change: FileChange) => {
    const payload = buildReviewPayload(change);
    if (!payload) {
      return;
    }

    getVsCodeApi()?.postMessage({
      type: 'review-snapshot',
      payload,
    });
  };

  if (changes.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 ml-0.5 overflow-hidden rounded-[18px] bg-[#171b23] border border-white/[0.08] shadow-[0_8px_24px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.06] bg-white/[0.015]">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#5e6ad2]/14 text-[#8b9cff]">
            <Files className="h-3.5 w-3.5" />
          </span>
          <span className="text-[12px] font-medium text-[#dce4f5]">
            {summarizeFileChanges(changes)}
          </span>
          {(hasTextStats || hasBinaryStats) && (
            <>
              {hasTextStats ? (
                <>
                  <span className="text-[11px] font-mono tabular-nums ml-1" style={{ color: DIFF_ADD_COLOR }}>+{totalAdditions}</span>
                  <span className="text-[11px] font-mono tabular-nums mr-1" style={{ color: DIFF_DEL_COLOR }}>-{totalDeletions}</span>
                </>
              ) : null}
              {changes.some((change) => change.isBinary) ? (
                <span className="text-[11px] text-[#a8b8ff]">
                  {changes.filter((change) => change.isBinary).length} binary
                </span>
              ) : null}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isHistorical && snapshotId && sessionId && hasUndoableChanges && (
            <button
              onClick={handleUndo}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[#b8c5de] hover:bg-white/[0.08] hover:text-[#e8eefb] transition-colors"
            >
              <Undo2 className="h-3 w-3 text-[#8b9ab8]" /> Undo
            </button>
          )}
          {changes.some(canReviewChange) && (
            <button
              onClick={handleReview}
              className="flex items-center gap-1.5 rounded-md bg-[#4f5fd4]/18 px-2 py-1 text-[11px] font-medium text-[#a8b8ff] border border-[#6b7ae8]/35 hover:bg-[#4f5fd4]/28 hover:border-[#7b88ee]/45 transition-colors"
            >
              <Search className="h-3 w-3" /> {changes.some((change) => change.isBinary && canReviewChange(change)) && !changes.some((change) => !change.isBinary && canReviewChange(change)) ? 'Open' : 'Review'}
            </button>
          )}
        </div>
      </div>
      <div className="px-1 py-1">
        {changes.map((change) => (
          <div
            key={change.changeId}
            className={`flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-white/[0.045] transition-colors group ${canReviewChange(change) ? 'cursor-pointer' : ''}`}
            onClick={() => handleReviewFile(change)}
          >
            <span
              className="flex items-center gap-1.5 min-w-0 max-w-[240px]"
              title={change.path}
            >
              <FileExtensionIcon path={change.path} />
              <span className="text-[11px] text-[#9fb0cd] font-mono truncate">
                {change.path}
              </span>
            </span>
            <div className="flex items-center gap-2 opacity-80 group-hover:opacity-100 transition-opacity">
              {fileChangeDetail(change) ? (
                <span className="text-[10px] font-medium text-[#a8b8ff]">{fileChangeDetail(change)}</span>
              ) : null}
              <ChangeStatBadges change={change} />
              {!canUndoChange(change) && canReviewChange(change) ? null : !canUndoChange(change) ? (
                <span className="text-[10px] text-[#7586a8]">Undo unavailable</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** @deprecated Use FileChangesCard */
export const SnapshotCard = FileChangesCard;

/** @deprecated Use FileChange */
export type DiffStat = FileChange;
