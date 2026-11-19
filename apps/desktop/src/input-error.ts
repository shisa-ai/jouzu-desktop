/**
 * Input the interface refused before anything was sent. `code` and `params`
 * pick the localized sentence (chat-text); `message` is the original English,
 * shown only under Details.
 */
export class InputError extends Error {
  constructor(readonly code: string, message: string, readonly params: Record<string, string | number> = {}) {
    super(message);
    this.name = "InputError";
  }
}
