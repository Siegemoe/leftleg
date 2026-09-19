// Composer-side prompt assembly: text files are inlined as fenced blocks,
// images travel as base64 payloads. Pure and unit-testable.

export interface ComposerAttachment {
  name: string;
  mimeType: string;
  data: string; // base64
  isImage: boolean;
}

export interface BuiltPrompt {
  msg: string;
  images: { data: string; mimeType: string; name: string }[];
}

const MAX_TEXT_FILE_CHARS = 40_000;

function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "(unreadable)";
  }
}

/** Build the prompt message + image payloads from composer text and attachments. */
export function buildPromptMessage(text: string, attachments: ComposerAttachment[]): BuiltPrompt {
  // Attachments with no payload (failed read, empty file edge) are skipped
  // with a visible note instead of emitting empty images or empty fences.
  const usable = attachments.filter((a) => a.data);
  const skipped = attachments.filter((a) => !a.data);
  const images = usable
    .filter((a) => a.isImage)
    .map((a) => ({ data: a.data, mimeType: a.mimeType, name: a.name }));
  let msg = text.trim();
  const textFiles = usable.filter((a) => !a.isImage);
  if (textFiles.length > 0 || skipped.length > 0) {
    const parts: string[] = msg ? [msg] : [];
    for (const f of skipped) parts.push(`(attachment skipped — no content: ${f.name})`);
    for (const f of textFiles) {
      let content = decodeBase64Utf8(f.data);
      if (content.length > MAX_TEXT_FILE_CHARS)
        content = content.slice(0, MAX_TEXT_FILE_CHARS) + "\n… (truncated)";
      const lang = (f.name.split(".").pop() ?? "").toLowerCase() || "";
      // The wrapper fence must out-run any backtick run inside the file, or
      // an embedded ``` pair would terminate the block early.
      const longestRun = (content.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      parts.push(`Attached file: ${f.name}\n${fence}${lang}\n${content}\n${fence}`);
    }
    msg = parts.join("\n\n");
  }
  return { msg, images };
}
