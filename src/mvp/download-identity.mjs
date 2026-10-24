import { bookKey, chapterOrigin, originKey } from './api.mjs';

export const downloadBranch = (book, branchId) => book.source === 'merged' ? '' : String(branchId ?? book.defaultBranchId ?? '');
export const downloadId = (book, branchId) => encodeURIComponent(JSON.stringify([bookKey(book), downloadBranch(book, branchId)]));
export function downloadOutlineId(book, chapters, branchId) {
  const value = JSON.stringify(chapters.map(chapter => [originKey(chapterOrigin(book, chapter, downloadBranch(book, branchId))), chapter.available !== false]));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `${chapters.length}-${(hash >>> 0).toString(36)}`;
}
