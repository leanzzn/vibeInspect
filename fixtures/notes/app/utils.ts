export function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
