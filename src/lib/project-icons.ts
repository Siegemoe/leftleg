// Project icon + color presentation choices (Leftleg-owned GUI preferences;
// persisted via ProjectMeta in leftleg.json — pi stays authoritative for
// agent state).

export const PROJECT_ICON_CHOICES = [
  // files & folders
  "📁", "📂", "🗂️", "📦", "🗃️",
  // work & code
  "⚡", "🧠", "🚀", "🛠️", "🧪", "📊", "💻", "🔧", "🔬", "🤖",
  // nature
  "🌱", "🌳", "🔥", "🌊", "🌍", "🌙", "☀️", "⭐", "🌈",
  // creatures
  "🐙", "🦊", "🐢", "🦉", "🐳", "🦄", "🐝", "🦖",
  // symbols & fun
  "🎨", "🎮", "🎯", "💡", "🧭", "🗝️", "💎", "🪐", "☕", "❤️",
];

/** Bold, saturated hues; "" = theme default. */
export const PROJECT_COLOR_CHOICES = [
  "",
  "#e5484d", // red
  "#e5650f", // orange
  "#f5a623", // amber
  "#30a46c", // green
  "#14b8a6", // teal
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
];

/** Inline style that tints an icon container with the project's color
 * (glyph color + a subtle wash of the same hue on the chip background). */
export function projectIconStyle(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return `color:${color};background:color-mix(in srgb, ${color} 18%, transparent)`;
}
