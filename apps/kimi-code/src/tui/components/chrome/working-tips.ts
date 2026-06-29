import { WORKING_TIPS, type ToolbarTip } from '#/tui/constant/tips';

export { WORKING_TIPS };

const TIP_ROTATE_INTERVAL_MS = 10_000;

/**
 * Build a rotation array where each tip appears a number of times
 * proportional to its `priority` (defaulting to 1). Higher-priority
 * tips recur more often. Adjacent duplicates are avoided by
 * distributing occurrences evenly across the rotation.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): ToolbarTip[] {
  if (tips.length === 0) return [];
  const items = tips.map((tip, i) => ({
    tip,
    weight: Math.max(1, Math.floor(tip.priority ?? 1)),
    index: i,
  }));
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  if (totalWeight === 0) return [];
  if (items.length === 1) return [items[0]!.tip];
  // When every weight is 1, preserve the original order.
  if (items.every((i) => i.weight === 1)) return items.map((i) => i.tip);

  // Spread occurrences evenly by assigning each an ideal position,
  // then sorting. The tiny index-based tiebreaker keeps same-item
  // copies from colliding and becoming adjacent.
  const entries: { tip: ToolbarTip; pos: number }[] = [];
  for (const item of items) {
    for (let j = 0; j < item.weight; j++) {
      entries.push({
        tip: item.tip,
        pos: ((j + 0.5) / item.weight) * totalWeight + item.index * 1e-10,
      });
    }
  }
  entries.sort((a, b) => a.pos - b.pos);
  return entries.map((e) => e.tip);
}

const WORKING_TIP_ROTATION = buildWeightedTips(WORKING_TIPS);

export function currentWorkingTip(now = Date.now()): ToolbarTip | undefined {
  if (WORKING_TIP_ROTATION.length === 0) return undefined;
  const index = Math.floor(now / TIP_ROTATE_INTERVAL_MS) % WORKING_TIP_ROTATION.length;
  return WORKING_TIP_ROTATION[index];
}

/**
 * Pick a random tip from the weighted working-tip rotation.
 * If `excludeText` is provided and there are other tips available, avoid
 * returning the same text twice in a row.
 */
export function pickRandomWorkingTip(excludeText?: string): ToolbarTip | undefined {
  if (WORKING_TIP_ROTATION.length === 0) return undefined;
  const candidates =
    excludeText === undefined || WORKING_TIP_ROTATION.length === 1
      ? WORKING_TIP_ROTATION
      : WORKING_TIP_ROTATION.filter((t) => t.text !== excludeText);
  const pool = candidates.length > 0 ? candidates : WORKING_TIP_ROTATION;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}
