// Minimal type shim for the Pi companion's imports. The real package is a
// global npm install (not a repo dependency); these declarations cover the
// surface the settings companion uses. Kept intentionally loose — the
// companion runs inside Pi's own process with Pi's real types.
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionCommandContext {
    cwd?: string;
    ui: {
      notify(message: string, level?: string): void;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }
  export interface ExtensionAPI {
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
    registerCommand(
      name: string,
      opts: {
        description?: string;
        handler: (args: string | undefined, ctx: ExtensionCommandContext) => void | Promise<void>;
      },
    ): void;
    [key: string]: unknown;
  }
}
