// FastEOS — exact port of pegasus:packages/hub/src/utils/FastEOS.ts.
//
// The original ASR contract (docs: "Simplified ASR") documents `fast_eos_array`
// as "a list of words and phrases that will be used to detect the response ASAP
// from incrementals" — the words are matched against *incremental* transcripts
// and, on a hit, the ASR session stops early and annotates the result FAST_EOS.
//
// The pinned buildRegex joins the trimmed non-empty phrases into `\b(a|b)\b`
// with the `i` flag and returns null when the list is empty/invalid. Phrases are
// deliberately NOT regex-escaped — that is the reference behavior.

export class FastEOS {
  /**
   * @param {string[]} fastEOSPhrases
   * @returns {RegExp|null} null if the phrases list is empty or invalid
   */
  static buildRegex(fastEOSPhrases) {
    if (Array.isArray(fastEOSPhrases)) {
      const validPhrases = fastEOSPhrases
        .map((phrase) => (typeof phrase === 'string' ? phrase.trim() : ''))
        .filter((phrase) => phrase.length > 0);
      if (validPhrases.length > 0) {
        const regexString = '\\b(' + validPhrases.join('|') + ')\\b';
        return new RegExp(regexString, 'i');
      }
    }
    return null;
  }
}
