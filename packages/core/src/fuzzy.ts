import { AmbiguousMatchError, NotFoundError, type FuzzyCandidate } from "./errors.js";

export type FuzzyMatch<T> = { score: number; item: T };

export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  extract: (item: T) => string,
): FuzzyMatch<T>[] {
  const q = query.toLowerCase();
  return items
    .map(item => ({
      item,
      score: similarity(q, extract(item).toLowerCase()),
    }))
    .sort((a, b) => b.score - a.score);
}

export type ResolveOneOpts = {
  threshold?: number; // default 0.9
  topN?: number;      // default 3, used in AmbiguousMatchError
  identify?: (item: unknown) => string | undefined;
};

export function resolveOne<T>(
  query: string,
  items: readonly T[],
  extract: (item: T) => string,
  opts: ResolveOneOpts = {},
): T {
  if (items.length === 0) {
    throw new NotFoundError(`No items to match against query: ${query}`);
  }

  const threshold = opts.threshold ?? 0.9;
  const topN = opts.topN ?? 3;
  const identify = opts.identify ?? (() => undefined);

  const ranked = fuzzyRank(query, items, extract);
  const top = ranked[0];

  if (!top) {
    throw new NotFoundError(`No items to match against query: ${query}`);
  }

  if (top.score >= threshold) {
    return top.item;
  }

  const candidates: FuzzyCandidate[] = ranked.slice(0, topN).map(m => ({
    score: m.score,
    label: extract(m.item),
    id: identify(m.item),
  }));

  throw new AmbiguousMatchError(
    `No confident match for "${query}" (top score ${top.score.toFixed(2)} below threshold ${threshold})`,
    { candidates },
  );
}

// Normalized Levenshtein-derived similarity in [0, 1].
// Exact match -> 1; totally different -> tends to 0.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  // Substring bonus: if query is a contiguous substring of candidate, boost.
  const substringBonus = b.includes(a) ? 0.15 : 0;
  return Math.min(1, 1 - dist / maxLen + substringBonus);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}
