/**
 * A readable provider name. Catalog providers are keyed as
 * `catalog:<source>:<encoded id>`; the id is what the user picked.
 */
export function providerLabel(provider?: string): string {
  if (!provider) return "—";
  if (!provider.startsWith("catalog:")) return provider;
  const encoded = provider.split(":")[2] || provider.split(":")[1] || provider;
  let id = encoded;
  try { id = decodeURIComponent(encoded); } catch { /* keep the encoded id */ }
  return id.replaceAll("-", " ").replaceAll("_", " ").replace(/\b\w/gu, character => character.toUpperCase());
}
