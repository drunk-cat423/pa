const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Shared by raw-history and Topic FTS indexes. */
export function memoryWords(text: string): string[] {
  return [...segmenter.segment(text.normalize('NFKC').toLocaleLowerCase('zh'))]
    .filter(segment => segment.isWordLike).map(segment => segment.segment);
}
