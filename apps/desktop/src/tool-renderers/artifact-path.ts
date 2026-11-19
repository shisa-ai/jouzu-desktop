// Older tool results stored the image path only in the text. Recover it so the
// artifact actions work for those results too.
export function artifactPathFromText(text: string): string | undefined {
  const match = text.match(/[A-Za-z]:\\[^\n\r"]+?\.(?:png|jpe?g|webp|gif)\b/iu);
  return match?.[0]?.trim();
}
