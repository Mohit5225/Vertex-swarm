import { diffLines, createTwoFilesPatch } from 'diff';

export interface DiffStats {
  additions: number;
  deletions: number;
  diffText: string;
}

export class DiffService {
  /**
   * Computes the line-level differences between the old text (snapshot) and the new text (live buffer).
   * Generates a unified diff format suitable for rendering.
   */
  public static computeDiff(fileName: string, oldText: string, newText: string): DiffStats {
    let additions = 0;
    let deletions = 0;

    const changes = diffLines(oldText, newText);
    for (const change of changes) {
      // The count of lines added/removed
      const lines = change.count || 0;
      if (change.added) {
        additions += lines;
      } else if (change.removed) {
        deletions += lines;
      }
    }

    // Generate a unified diff
    const diffText = createTwoFilesPatch(
      fileName,
      fileName,
      oldText,
      newText,
      'snapshot',
      'live',
      { context: 3 }
    );

    return {
      additions,
      deletions,
      diffText
    };
  }
}
