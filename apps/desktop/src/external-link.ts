/**
 * One owner for opening a link that came from the transcript (#201).
 *
 * Transcript content is untrusted, so the URL is checked here once for every
 * client (ADR 0005): ordinary `http`/`https` only, no embedded credentials.
 * Who opens it depends on the client: the desktop shell hands it to the OS
 * through the app's validated native command, and a browser client opens it
 * itself — a browser is the right handler for a link, and the native boundary
 * does not exist there (ADR 0021).
 */
import type { JouzuApi } from "./api/jouzu-api";

/** The URL a transcript link may open, or null when it is not an external link. */
export function externalLinkTarget(href: string | undefined): string | null {
  try {
    const url = new URL(href ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    // Not a URL at all: the link stays inert.
    return null;
  }
}

/**
 * Open `url` from a control, where no anchor does it. A browser client opens a
 * new tab; the click is the person's, so it is not treated as a popup.
 */
export async function openExternalLink(api: JouzuApi | null, url: string): Promise<void> {
  const safe = externalLinkTarget(url);
  if (!safe) throw new Error("This link cannot be opened externally.");
  if (api?.capabilities.native) {
    await api.native.openExternalUrl(safe);
    return;
  }
  const link = document.createElement("a");
  link.href = safe;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
}
