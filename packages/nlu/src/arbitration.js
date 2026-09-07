// Source-compatible selection of already-scored parser results.
//
// RobustParserClient.getBestResult compares the native heuristic score first.
// Equal scores retain response/result order, except that launch and globals/*
// are removed from a tie when a non-loser is present.  This helper deliberately
// does not inspect entity priority: the source stores that metadata in NLParse,
// while getBestResult receives the numeric heuristic score separately.

const LOW_PRIORITY_RULES = /^launch$|^globals\//;

/**
 * @param {Array<null|{rule:string,score:number}>} candidates flattened in
 * source response/result order
 * @returns {null|{rule:string,score:number}}
 */
export function selectBestNative(candidates) {
  let topResults = [];
  let topScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    if (candidate.score >= topScore) {
      if (candidate.score > topScore) {
        topResults = [];
        topScore = candidate.score;
      }
      topResults.push(candidate);
    }
  }
  if (topResults.length > 1 && topResults.some(result => !LOW_PRIORITY_RULES.test(result.rule))) {
    topResults = topResults.filter(result => !LOW_PRIORITY_RULES.test(result.rule));
  }
  return topResults[0] || null;
}

export { LOW_PRIORITY_RULES };
