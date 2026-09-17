// Project icon + color presentation choices (Leftleg-owned GUI preferences;
// persisted via ProjectMeta in leftleg.json — pi stays authoritative for
// agent state).
//
// Icons are Lucide names (kebab-case) from the same pack used across the UI
// (@lucide/svelte). Values persisted before the Lucide switch are legacy
// emoji strings: projectIconComponent() resolves known Lucide names and maps
// common legacy emoji to their nearest glyph; anything else renders verbatim
// so old picks keep working.
import {
  Gamepad2, Swords, Trophy, Ghost, Crown, Joystick, Dice5, Puzzle, Target, Hourglass,
  CodeXml, Terminal, Braces, Binary, Bug, Bot, Cpu, Database, GitBranch, GitCompare,
  Rocket, Zap, Monitor, HardDrive, CircuitBoard, MemoryStick, Keyboard, Usb, Cable, Wifi,
  Satellite, Antenna, Radio,
  Brain, Atom, Orbit, Telescope, FlaskConical, Coffee, Wrench, Shield, Globe,
  FolderOpen, Layers, Box, Palette, Camera, Clapperboard, Headphones, Sparkles,
  Footprints, Folder, Lightbulb,
} from "@lucide/svelte";

/** Curated picker set: gaming, programming, tech — plus a few general marks. */
export const PROJECT_ICON_CHOICES: readonly string[] = [
  // gaming
  "gamepad-2", "swords", "trophy", "ghost", "crown", "joystick", "dice-5", "puzzle", "target",
  // programming
  "code-xml", "terminal", "braces", "binary", "bug", "bot", "cpu", "database", "git-branch", "git-compare",
  // tech & hardware
  "rocket", "zap", "monitor", "hard-drive", "circuit-board", "memory-stick", "keyboard", "usb", "cable",
  "wifi", "satellite", "antenna", "radio",
  // general
  "brain", "atom", "orbit", "telescope", "flask-conical", "coffee", "wrench", "shield", "globe",
  "folder-open", "layers", "box", "palette", "camera", "clapperboard", "headphones", "sparkles",
  "footprints", "folder",
];

type LucideComponent = typeof Gamepad2;

/** Choice name -> Lucide component (mirrors PROJECT_ICON_CHOICES). */
export const PROJECT_ICONS: Record<string, LucideComponent> = {
  "gamepad-2": Gamepad2, "swords": Swords, "trophy": Trophy, "ghost": Ghost, "crown": Crown,
  "joystick": Joystick, "dice-5": Dice5, "puzzle": Puzzle, "target": Target, "hourglass": Hourglass,
  "code-xml": CodeXml, "terminal": Terminal, "braces": Braces, "binary": Binary, "bug": Bug,
  "bot": Bot, "cpu": Cpu, "database": Database, "git-branch": GitBranch, "git-compare": GitCompare,
  "rocket": Rocket, "zap": Zap, "monitor": Monitor, "hard-drive": HardDrive,
  "circuit-board": CircuitBoard, "memory-stick": MemoryStick, "keyboard": Keyboard,
  "usb": Usb, "cable": Cable, "wifi": Wifi, "satellite": Satellite, "antenna": Antenna,
  "radio": Radio,
  "brain": Brain, "atom": Atom, "orbit": Orbit, "telescope": Telescope,
  "flask-conical": FlaskConical, "coffee": Coffee, "wrench": Wrench, "shield": Shield,
  "globe": Globe, "folder-open": FolderOpen, "layers": Layers, "box": Box,
  "palette": Palette, "camera": Camera, "clapperboard": Clapperboard,
  "headphones": Headphones, "sparkles": Sparkles, "footprints": Footprints, "folder": Folder,
};

/** Pre-Lucide picks: map surviving emoji values to their nearest glyph. */
const LEGACY_EMOJI: Record<string, LucideComponent> = {
  "⚡": Zap, "🤖": Bot, "🎮": Gamepad2, "🧠": Brain, "💻": Monitor, "🚀": Rocket,
  "🛠️": Wrench, "🔧": Wrench, "🧪": FlaskConical, "☕": Coffee, "🎨": Palette,
  "🎯": Target, "💡": Lightbulb, "📁": Folder, "📂": FolderOpen, "📦": Box,
};

/** Resolve a stored icon value to a Lucide component; null = render raw. */
export function projectIconComponent(icon: string | undefined | null): LucideComponent | null {
  if (!icon) return null;
  return PROJECT_ICONS[icon] ?? LEGACY_EMOJI[icon] ?? null;
}

/** Human label for a choice name ("gamepad-2" -> "Gamepad 2"). */
export function projectIconLabel(name: string): string {
  return name
    .split("-")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

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
