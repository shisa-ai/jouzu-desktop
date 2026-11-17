export interface ControlState {
  modelReady?: boolean;
  connectionCheck?: { provider: string; status: string };
  profile: string | null;
  account: { signedIn: boolean; revocation?: "confirmed" | "unconfirmed" | "not-linked" };
  customProviders: { id: string; url: string; model: string; editable: boolean; imageInput?: boolean; contextWindow?: number; maxTokens?: number }[];
  providers: { id: string; name: string; oauth?: boolean; oauthName?: string; apiKey?: boolean }[];
  credentials: { providerId: string }[];
  defaultProvider?: string;
  defaultModel?: string;
  /** The last catalog refresh: what happened, and a held revision when one waits. */
  catalog?: CatalogOutcome;
  /** Jouzu's own language settings (localization.json), as a new runtime resolves them. */
  language?: LanguageState;
}
export const RESPONSE_LANGUAGES = ["auto", "en", "ja", "zh-Hans", "zh-Hant"] as const;
export const ARTIFACT_LANGUAGES = ["preserve", "project", "en", "ja", "zh-Hans", "zh-Hant"] as const;
export const ARTIFACT_FIELDS = ["comments", "documentation", "commits", "reviews"] as const;
export type ArtifactLanguage = typeof ARTIFACT_LANGUAGES[number];
export type ArtifactPolicy = Record<typeof ARTIFACT_FIELDS[number], ArtifactLanguage>;
/** Jouzu's built-in policy: comments keep their language, the rest follow the project. */
export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = { comments: "preserve", documentation: "project", commits: "project", reviews: "project" };
export interface LanguageState {
  /** "ok", "absent", or a file Jouzu refuses to read or overwrite ("invalid", "future"). */
  status: string;
  uiLocale: { requested: string; effective: string; source: string };
  responseLanguage: { requested: string; effective: string; source: string };
  artifactPolicy: { effective: ArtifactPolicy; source: string };
}
/** The same presets Jouzu's Settings offers: its default, or one language for every field.
 *  A per-field mix written elsewhere is "custom" and is shown, never rewritten. */
export function artifactPreset(policy: ArtifactPolicy): "default" | ArtifactLanguage | "custom" {
  if (ARTIFACT_FIELDS.every(field => policy[field] === DEFAULT_ARTIFACT_POLICY[field])) return "default";
  const first = policy[ARTIFACT_FIELDS[0]];
  return ARTIFACT_FIELDS.every(field => policy[field] === first) ? first : "custom";
}
export function artifactPolicyFor(preset: "default" | ArtifactLanguage): ArtifactPolicy {
  return preset === "default" ? { ...DEFAULT_ARTIFACT_POLICY } : { comments: preset, documentation: preset, commits: preset, reviews: preset };
}
export interface HeldCatalog {
  sourceId: string;
  revision: string;
  digest: string;
  reasons: string[];
  changes: unknown;
}
export interface CatalogOutcome {
  status: string;
  sources: { sourceId: string; status: string }[];
  held: HeldCatalog | null;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Human summary of a held revision's model changes, or an empty string when the
 *  runtime sent no counts. Never invents numbers. */
export function catalogChangeSummary(changes: unknown): string {
  if (!record(changes)) return "";
  const { activeCount, candidateCount, added, removed } = changes;
  if (typeof activeCount !== "number" || typeof candidateCount !== "number") return "";
  const parts = [`This revision has ${candidateCount} model${candidateCount === 1 ? "" : "s"}; ${activeCount} in use now.`];
  if (typeof added === "number" && added > 0) parts.push(`${added} added`);
  if (typeof removed === "number" && removed > 0) parts.push(`${removed} removed`);
  return parts.join(" ");
}
export function parseControlState(value: unknown): ControlState {
  const fail = () => { throw new Error("Configuration service response is incompatible. Restart the development launcher and retry."); };
  if (!record(value)) return fail();
  if (value.schemaVersion !== 1 || !record(value.account) || typeof value.account.signedIn !== "boolean" || !(value.profile === null || typeof value.profile === "string")) return fail();
  if (value.modelReady !== undefined && typeof value.modelReady !== "boolean") return fail();
  if (value.account.revocation !== undefined && !["confirmed", "unconfirmed", "not-linked"].includes(value.account.revocation as string)) return fail();
  const fields = { credentials: ["providerId"], providers: ["id", "name"], customProviders: ["id"] };
  for (const [key, required] of Object.entries(fields)) {
    const rows = value[key];
    if (!Array.isArray(rows) || !rows.every(row => record(row) && required.every(field => typeof row[field] === "string" && (row[field] as string).length > 0))) return fail();
  }
  for (const row of value.customProviders as Record<string, unknown>[]) {
    if (typeof row.editable !== "boolean" || (row.editable && (typeof row.url !== "string" || typeof row.model !== "string"))) return fail();
  }
  for (const row of value.providers as Record<string, unknown>[]) {
    if (row.oauth !== undefined && typeof row.oauth !== "boolean") return fail();
    if (row.apiKey !== undefined && typeof row.apiKey !== "boolean") return fail();
    for (const key of ["oauthName"]) if (row[key] !== undefined && typeof row[key] !== "string") return fail();
  }
  for (const key of ["defaultProvider", "defaultModel"]) if (value[key] !== undefined && typeof value[key] !== "string") return fail();
  if (value.connectionCheck !== undefined && (!record(value.connectionCheck) || typeof value.connectionCheck.provider !== "string" || typeof value.connectionCheck.status !== "string")) return fail();
  if (value.catalog !== undefined) {
    const catalog = value.catalog;
    if (!record(catalog) || typeof catalog.status !== "string" || !Array.isArray(catalog.sources)) return fail();
    if (!catalog.sources.every(row => record(row) && typeof row.sourceId === "string" && typeof row.status === "string")) return fail();
    if (catalog.held !== null && catalog.held !== undefined) {
      const held = catalog.held;
      if (!record(held) || typeof held.revision !== "string" || typeof held.digest !== "string" || !Array.isArray(held.reasons)) return fail();
      if (!held.reasons.every(reason => typeof reason === "string")) return fail();
    }
  }
  if (value.language !== undefined) {
    const language = value.language;
    const resolved = (entry: unknown) => record(entry) && ["requested", "effective", "source"].every(key => typeof entry[key] === "string");
    if (!record(language) || typeof language.status !== "string" || !resolved(language.uiLocale) || !resolved(language.responseLanguage)) return fail();
    const artifact = language.artifactPolicy;
    if (!record(artifact) || typeof artifact.source !== "string" || !record(artifact.effective)) return fail();
    const effective = artifact.effective;
    if (!ARTIFACT_FIELDS.every(field => (ARTIFACT_LANGUAGES as readonly string[]).includes(effective[field] as string))) return fail();
  }
  return value as unknown as ControlState;
}
