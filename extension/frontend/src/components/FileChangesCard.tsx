import React from 'react';
import { Undo2, Search, FileSignature } from 'lucide-react';
import { getVsCodeApi } from '../lib/vscode';
import {
  canUndoChange,
  fileChangeDetail,
  shouldShowLineStats,
  summarizeFileChanges,
} from '../lib/fileChangeStats';
import { buildReviewPayload, canReviewChange } from '../lib/reviewPayload';
import type { FileChange, FileChangeOperation } from '../lib/fileChangeTypes';

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
  const totalAdditions = changes.reduce((acc, change) => acc + change.additions, 0);
  const totalDeletions = changes.reduce((acc, change) => acc + change.deletions, 0);
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
    <div className="mt-2 ml-0.5 overflow-hidden rounded-[18px] bg-[#1a1e26] border border-white/[0.05] shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-[#7f91b4]" />
          <span className="text-[12px] font-medium text-[#c6d2e7]">
            {summarizeFileChanges(changes)}
          </span>
          {(totalAdditions > 0 || totalDeletions > 0) && (
            <>
              <span className="text-[11px] font-mono text-[#2dd4bf] ml-1">+{totalAdditions}</span>
              <span className="text-[11px] font-mono text-[#f43f5e] mr-1">-{totalDeletions}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isHistorical && snapshotId && sessionId && hasUndoableChanges && (
            <button
              onClick={handleUndo}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[#c6d2e7] hover:bg-white/[0.1] transition-colors"
            >
              <Undo2 className="h-3 w-3" /> Undo
            </button>
          )}
          {changes.some(canReviewChange) && (
            <button
              onClick={handleReview}
              className="flex items-center gap-1.5 rounded-md bg-[#5e6ad2]/20 px-2 py-1 text-[11px] font-medium text-[#9eb1ff] border border-[#5e6ad2]/30 hover:bg-[#5e6ad2]/30 transition-colors"
            >
              <Search className="h-3 w-3" /> Review
            </button>
          )}
        </div>
      </div>
      <div className="px-1 py-1">
        {changes.map((change) => (
          <div
            key={change.changeId}
            className={`flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors group ${canReviewChange(change) ? 'cursor-pointer' : ''}`}
            onClick={() => handleReviewFile(change)}
          >
            <span
              className="text-[11px] text-[#91a0bb] font-mono truncate max-w-[240px]"
              title={change.path}
            >
              {change.path}
            </span>
            <div className="flex items-center gap-2 opacity-70 group-hover:opacity-100 transition-opacity">
              {fileChangeDetail(change) ? (
                <span className="text-[10px] font-medium text-[#9eb1ff]">{fileChangeDetail(change)}</span>
              ) : null}
              {shouldShowLineStats(change) ? (
                <>
                  <span className="text-[10px] font-mono text-[#2dd4bf]">+{change.additions}</span>
                  <span className="text-[10px] font-mono text-[#f43f5e]">-{change.deletions}</span>
                </>
              ) : null}
              {!canUndoChange(change) && canReviewChange(change) ? null : !canUndoChange(change) ? (
                <span className="text-[10px] text-[#6f81a1]">Undo unavailable</span>
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
