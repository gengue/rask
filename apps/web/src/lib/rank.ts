export interface Rankable {
  label: string;
  section: string;
}

/**
 * Subsequence match, scored by contiguity and how early the match starts.
 *
 * Subsequence matching is what makes "eng" find "Engineering". It is also what
 * let "invoice" match "TS preparation - DMC trips / VEOT (Venezuela Online
 * Traveler C.A.)" and outrank tasks with the word in their title. Past three
 * characters the user is typing a word rather than an abbreviation, so require
 * it to actually appear.
 */
const SUBSEQUENCE_LIMIT = 3;

export function rankCommands<T extends Rankable>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  if (q.length > SUBSEQUENCE_LIMIT) {
    return items.filter((item) => `${item.label} ${item.section}`.toLowerCase().includes(q));
  }

  const scored: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const haystack = `${item.label} ${item.section}`.toLowerCase();
    let index = 0;
    let score = 0;
    let previous = -1;

    for (const char of q) {
      const found = haystack.indexOf(char, index);
      if (found === -1) {
        score = -1;
        break;
      }
      score += found === previous + 1 ? 3 : 1;
      if (found === 0 || haystack[found - 1] === " ") score += 2;
      previous = found;
      index = found + 1;
    }

    if (score > 0) scored.push({ item, score: score - haystack.length * 0.01 });
  }

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.item);
}
