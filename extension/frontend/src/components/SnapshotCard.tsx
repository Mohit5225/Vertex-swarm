import React from 'react';
import { Undo2, Search, FileSignature } from 'lucide-react';
import { getVsCodeApi } from '../lib/vscode';

export interface DiffStat {
  file: string;
  originalUri: string;
  snapshotPath: string;
  additions: number;
  deletions: number;
  diffText: string;
}

interface SnapshotCardProps {
  snapshotId: string;  // UUID from the SnapshotManifest
  sessionId: string;   // The chat/session ID
  messageId: string;   // The message_id used as the snapshot directory key
  diffs: DiffStat[];
  isHistorical?: boolean;
}

export const SnapshotCard: React.FC<SnapshotCardProps> = ({ snapshotId, sessionId, messageId, diffs, isHistorical }) => {
  const totalAdditions = diffs.reduce((acc, d) => acc + d.additions, 0);
  const totalDeletions = diffs.reduce((acc, d) => acc + d.deletions, 0);
  const fileCount = diffs.length;

  const handleUndo = () => {
    getVsCodeApi()?.postMessage({
      type: 'undo-snapshot',
      // snapshotId is the UUID stored in the manifest.
      // messageId is the directory key used to find the snapshot on disk.
      // sessionId scopes the top-level directory.
      payload: { snapshotId, sessionId, messageId }
    });
  };

  const handleReview = () => {
    // Open the first file's diff or a specific one if needed.
    // For now, let's open the first one. 
    // Ideally we could open all or let the user click individual files below.
    if (diffs.length > 0) {
      const first = diffs[0];
      getVsCodeApi()?.postMessage({
        type: 'review-snapshot',
        payload: { file: first.file, originalUri: first.originalUri, snapshotPath: first.snapshotPath }
      });
    }
  };

  const handleReviewFile = (diff: DiffStat) => {
    getVsCodeApi()?.postMessage({
      type: 'review-snapshot',
      payload: { file: diff.file, originalUri: diff.originalUri, snapshotPath: diff.snapshotPath }
    });
  };

  if (diffs.length === 0) return null;

  return (
    <div className="mt-2 ml-0.5 overflow-hidden rounded-[18px] bg-[#1a1e26] border border-white/[0.05] shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-[#7f91b4]" />
          <span className="text-[12px] font-medium text-[#c6d2e7]">
            Edited {fileCount} file{fileCount !== 1 ? 's' : ''}
          </span>
          <span className="text-[11px] font-mono text-[#2dd4bf] ml-1">+{totalAdditions}</span>
          <span className="text-[11px] font-mono text-[#f43f5e] mr-1">-{totalDeletions}</span>
        </div>
        <div className="flex items-center gap-2">
          {!isHistorical && snapshotId && sessionId && (
            <button
              onClick={handleUndo}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[#c6d2e7] hover:bg-white/[0.1] transition-colors"
            >
              <Undo2 className="h-3 w-3" /> Undo
            </button>
          )}
          <button
            onClick={handleReview}
            className="flex items-center gap-1.5 rounded-md bg-[#5e6ad2]/20 px-2 py-1 text-[11px] font-medium text-[#9eb1ff] border border-[#5e6ad2]/30 hover:bg-[#5e6ad2]/30 transition-colors"
          >
            <Search className="h-3 w-3" /> Review
          </button>
        </div>
      </div>
      <div className="px-1 py-1">
        {diffs.map((d, i) => (
          <div key={i} className="flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors group cursor-pointer" onClick={() => handleReviewFile(d)}>
            <span className="text-[11px] text-[#91a0bb] font-mono truncate max-w-[200px]">{d.file}</span>
            <div className="flex items-center gap-2 opacity-70 group-hover:opacity-100 transition-opacity">
              <span className="text-[10px] font-mono text-[#2dd4bf]">+{d.additions}</span>
              <span className="text-[10px] font-mono text-[#f43f5e]">-{d.deletions}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
