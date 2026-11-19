import { InputError } from "./input-error";

/** A video URL is sent as text; the capy proxy rewrites the marker to Qwen's
 * video_url block. Validate the same public-https rules the proxy enforces so
 * the user sees the error before sending. */
export function normalizeVideoUrl(input: string): string {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError("video-url-invalid", "Enter a full https video URL."); }
  if (url.protocol !== "https:") throw new InputError("video-url-https", "Video URLs must use https.");
  if (url.username || url.password) throw new InputError("video-url-credentials", "Video URLs cannot contain credentials.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new InputError("video-url-host", "Video URLs must use a public host.");
  if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(host) || host.startsWith("[")) throw new InputError("video-url-host", "Video URLs must use a public host.");
  return url.href;
}

export function videoMarker(url: string): string {
  return `@video:${url}`;
}
