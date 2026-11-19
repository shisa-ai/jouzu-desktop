/**
 * Helpers that work in every context the UI runs in. The desktop window and
 * http://127.0.0.1 are secure contexts, but web access from another device is
 * plain http to a LAN or Tailscale address (issue #91), where browsers leave out
 * `crypto.randomUUID` and `navigator.clipboard`. `crypto.getRandomValues` and
 * `document.execCommand("copy")` remain available there.
 */

/** A random RFC 4122 version 4 UUID. */
export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Copies text to the clipboard; rejects when the browser refuses. */
export async function copyText(text: string): Promise<void> {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error("The browser did not allow copying");
  } finally {
    area.remove();
  }
}
