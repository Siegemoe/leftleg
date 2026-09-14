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
    registerTool(definition: {
      name: string;
      label?: string;
      description?: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown; // runtime TypeBox schema (validated by pi)
      execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: ((update: { content: Array<{ type: string; text?: string }> }) => void) | undefined,
        ctx: ExtensionToolContext,
      ) => Promise<unknown> | unknown;
      [key: string]: unknown;
    }): void;
    [key: string]: unknown;
  }

  /** Tool-execute context subset (real shape lives in pi's own types). */
  export interface ExtensionToolContext {
    cwd?: string;
    modelRegistry: {
      getProviderAuth(provider: string): Promise<
        | { auth: { apiKey?: string; baseUrl?: string }; source?: string }
        | undefined
      >;
    };
    [key: string]: unknown;
  }
}
