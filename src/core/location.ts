/**
 * Offset → line/column translation.
 *
 * oxc emits `start`/`end` character offsets on every node but no `loc`. We build
 * one sorted array of line-start offsets per file and binary search it. Lines
 * and columns are 1-based to match editors and the JSON schema.
 */

export type Locator = (offset: number) => { line: number; column: number };

/** Build a fast offset→{line,column} locator for a source string. */
export const createLocator = (sourceText: string): Locator => {
  // lineStarts[i] = offset at which line (i + 1) begins. Line 1 starts at 0.
  const lineStarts: number[] = [0];
  for (let i = 0; i < sourceText.length; i++) {
    if (sourceText.charCodeAt(i) === 10 /* \n */) {
      lineStarts.push(i + 1);
    }
  }

  return (offset) => {
    if (typeof offset !== "number" || offset < 0) {
      return { line: 1, column: 1 };
    }
    // Binary search for the greatest lineStart <= offset.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
  };
};
