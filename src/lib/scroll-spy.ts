/** Pure decision core of Chat's prompt-rail scroll-spy (see Chat.svelte,
 * which owns the DOM reads). Returns the id of the user prompt that reads
 * as "where you are", or null with no anchors.
 *
 * Rule: the last anchor whose top has crossed `viewportTop + thresholdPx`
 * is active. At max scroll a short final turn can never cross the
 * threshold (the anchor is clamped above it), so when the view is at
 * (near) bottom the last prompt is active by definition — this is what
 * keeps the clicked last tick highlighted instead of falling back to the
 * previous one. */
export function pickActivePrompt(
  anchors: { id: string; top: number }[],
  viewportTop: number,
  atBottom: boolean,
  thresholdPx = 120,
): string | null {
  if (anchors.length === 0) return null;
  if (atBottom) return anchors[anchors.length - 1].id;
  let active: string | null = null;
  for (const a of anchors) {
    if (a.top <= viewportTop + thresholdPx) active = a.id;
    else break;
  }
  return active;
}
