export function architectureEvidence(evidence, options = {}) {
  const maxCandidates = options.maxCandidates ?? 8, candidateOffset = options.candidateOffset ?? 0;
  const result = { ...evidence };
  if (evidence.resolution?.candidates) {
    const candidates = evidence.resolution.candidates;
    result.resolution = { ...evidence.resolution, candidates: candidates.slice(candidateOffset, candidateOffset + maxCandidates),
      candidatesCount: candidates.length, omittedCandidates: candidates.length - Math.min(maxCandidates, Math.max(0, candidates.length - candidateOffset)),
      nextCandidateOffset: candidateOffset + maxCandidates < candidates.length ? candidateOffset + maxCandidates : null };
  }
  if (evidence.argumentSites) {
    result.argumentSites = evidence.argumentSites.slice(0, options.maxArgumentSites ?? 3);
    result.argumentSitesCount = evidence.argumentSites.length;
    result.omittedArgumentSites = evidence.argumentSites.length - result.argumentSites.length;
  }
  return result;
}
