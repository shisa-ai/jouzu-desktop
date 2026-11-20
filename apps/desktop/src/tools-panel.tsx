import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { fill, useChatText, type ChatText } from "./chat-text";

export interface ImageSettings {
  enabled: boolean;
  provider: string;
  model: string;
  size: string;
  maxImages: number;
}

interface ToolsSettings {
  image: ImageSettings;
  reviewTools: string[];
}

interface ImageModel {
  id: string;
  /** Empty when the model takes no size setting (the runtime's image models). */
  sizes: string[];
}

/** An image provider as the extension reports it: usable now, or the reason it is not. */
export interface ImageProvider {
  id: string;
  label: string;
  available: boolean;
  /** Why it is not usable, as a code this page words; `reason` is the original text. */
  code: string;
  reason: string;
  models: ImageModel[] | null;
}

/** A provider connected under Model providers, used to name what cannot make images. */
export interface ConnectedProvider {
  id: string;
  name: string;
}

const SIZES = ["1K", "2K", "4K"];

/** Why an image provider is not usable, in the interface language. */
function imageWhy(t: ChatText, code: string): string {
  const key = ({
    "no-credential": "imageWhyNoCredential",
    "sign-in-refused": "imageWhySignInRefused",
    "not-allowed": "imageWhyNotAllowed",
    "no-credit": "imageWhyNoCredit",
    "no-models": "imageWhyNoModels",
    unreachable: "imageWhyUnreachable",
    busy: "imageWhyBusy",
  } as const)[code];
  return key ? t[key] : t.notAvailable;
}
const MAX_IMAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const select = "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

function readModels(value: unknown): ImageModel[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.flatMap(item => {
    if (typeof item === "string") return [{ id: item, sizes: SIZES }];
    const entry = item as { id?: unknown; sizes?: unknown };
    const id = typeof entry?.id === "string" ? entry.id : "";
    const sizes = Array.isArray(entry?.sizes) && entry.sizes.every((size: unknown) => typeof size === "string") ? entry.sizes as string[] : SIZES;
    return id ? [{ id, sizes }] : [];
  });
}

function readProviders(value: unknown): ImageProvider[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.flatMap(item => {
    const entry = item as { id?: unknown; label?: unknown; available?: unknown; code?: unknown; reason?: unknown; models?: unknown };
    if (typeof entry?.id !== "string" || !entry.id) return [];
    return [{
      id: entry.id,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
      available: entry.available !== false,
      code: typeof entry.code === "string" ? entry.code : "",
      reason: typeof entry.reason === "string" ? entry.reason : "",
      models: Array.isArray(entry.models) ? readModels(entry.models) : null,
    }];
  });
}

/** The chain the card draws: provider that can make images -> its model -> sizes. */
export function imageChain(providers: ImageProvider[], image: ImageSettings) {
  const usable = providers.filter(provider => provider.available);
  const selected = usable.find(provider => provider.id === image.provider) ?? usable[0];
  const models = selected?.models ?? [];
  const model = models.find(entry => entry.id === image.model) ?? models[0];
  const sizes = model?.sizes ?? [];
  const size = sizes.includes(image.size) ? image.size : sizes[0] ?? image.size;
  return { usable, selected, models, model, sizes, size, canGenerate: usable.length > 0 };
}

/** The one line a card with no usable provider shows, plus the reasons under Details. */
export function ImageMissingNotice({ providers, connected = [], onModelProviders }: { providers: ImageProvider[]; connected?: ConnectedProvider[]; onModelProviders?: () => void }) {
  const t = useChatText();
  const unusable = providers.filter(provider => !provider.available);
  // Providers connected under Model providers that have no image capability,
  // such as Codex. They are named once, on the card's one line.
  const otherConnected = [...new Set(connected.filter(item => !providers.some(provider => provider.id === item.id)).map(item => item.name))];
  const candidates = [...new Set(providers.map(provider => provider.label))];
  const line = otherConnected.length
    ? fill(t.imageConnectedCannot, { connected: otherConnected.join(", "), providers: candidates.join(", ") || t.modelProviders })
    : candidates.length
      ? fill(t.imageConnectProviders, { providers: candidates.join(", ") })
      : t.imageConnectAnyProvider;
  return <>
    <p role="status" data-image-no-provider className="text-sm text-muted-foreground">{line}</p>
    {onModelProviders && <Button variant="outline" onClick={onModelProviders}>{t.modelProviders}</Button>}
    {unusable.length > 0 && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{t.details}</summary>
      <ul aria-label={t.unavailableImageProviders} className="mt-2 space-y-1">
        {unusable.map(provider => <li key={provider.id} title={provider.reason || undefined}>{provider.label}: {imageWhy(t, provider.code)}</li>)}
      </ul>
    </details>}
  </>;
}

/**
 * The image chain the card shows: a provider that can make images, its model,
 * and the sizes that model takes. Each level exists only when the one above has
 * a value (ui-layer §6.1). The saved switch is never turned off by the page.
 */
export function ToolsPanel({ connected = [], onModelProviders }: { connected?: ConnectedProvider[]; onModelProviders?: () => void }) {
  const t = useChatText();
  const api = useApi();
  const [tools, setTools] = useState<ToolsSettings | null>(null);
  const [providers, setProviders] = useState<ImageProvider[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errorPlace, setErrorPlace] = useState<"providers" | "save">("providers");
  // The image tool is not installed yet: a state of the tool, not a failure (#157).
  const [notInstalled, setNotInstalled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const value = (await api.tools.settings()).settings as unknown as ToolsSettings;
        setTools(value);
        let list: ImageProvider[] = [];
        try {
          list = readProviders((await api.tools.providers()).providers);
        } catch (failure) {
          if ((failure as { code?: unknown } | null)?.code === "tools-unavailable") {
            setNotInstalled(true);
            setProviders([]);
            return;
          }
          throw failure;
        }
        setProviders(list);
        // When the feature is on, the saved chain must point at a provider that
        // can work now; choosing one keeps "on" meaning it works. The saved
        // switch itself is not changed.
        const usable = list.filter(provider => provider.available);
        const chosen = usable.find(provider => provider.id === value.image.provider) ?? usable[0];
        if (!value.image.enabled || !chosen) return;
        const models = chosen.models ?? [];
        const model = models.find(entry => entry.id === value.image.model) ?? models[0];
        const size = model && model.sizes.length && !model.sizes.includes(value.image.size) ? model.sizes[0] : value.image.size;
        if (chosen.id !== value.image.provider || model?.id !== value.image.model || size !== value.image.size) {
          const saved = await api.tools.save({ ...value.image, provider: chosen.id, model: model?.id ?? "", size }) as unknown as ToolsSettings;
          setTools(saved);
        }
      } catch (failure) {
        setErrorPlace("providers");
        setError(failure);
      }
    })();
  }, []);

  async function save(patch: Partial<ImageSettings>) {
    if (!tools) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.tools.save({ ...tools.image, ...patch }) as unknown as ToolsSettings;
      setTools(saved);
    } catch (failure) {
      setErrorPlace("save");
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (!tools) return <Card className="border-border shadow-none">
    <CardHeader><CardTitle>{t.imageGeneration}</CardTitle><CardDescription>{t.imageGenerationHint}</CardDescription></CardHeader>
    <CardContent>{error ? <ErrorLine raw={error} failed={t.toolsChangeFailed} onDismiss={() => setError(null)} /> : <p className="text-sm text-muted-foreground">{t.loadingTools}</p>}</CardContent>
  </Card>;

  const image = tools.image;
  const { usable, selected, models, model, sizes, size, canGenerate } = imageChain(providers ?? [], image);
  const on = image.enabled && canGenerate;

  const toggle = (next: boolean) => {
    if (next && selected) {
      void save({ enabled: true, provider: selected.id, model: model?.id ?? "", size });
      return;
    }
    void save({ enabled: false });
  };

  return <Card className="border-border shadow-none">
    <CardHeader>
      <CardTitle>{t.imageGeneration}</CardTitle>
      <CardDescription>{t.imageGenerationHint}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="image-enabled">{t.enableImageGeneration}</Label>
        <Switch id="image-enabled" aria-label={t.enableImageGeneration} checked={on} disabled={busy || providers === null || notInstalled || !canGenerate} onCheckedChange={toggle} />
      </div>
      {error != null && errorPlace === "providers" && <ErrorLine raw={error} failed={t.toolsChangeFailed} onDismiss={() => setError(null)} />}
      {!notInstalled && providers === null && error == null && <p className="text-sm text-muted-foreground">{t.loadingTools}</p>}
      {notInstalled && <p role="status" data-tools-not-installed className="text-sm text-muted-foreground">{t.codeToolsUnavailable}</p>}
      {providers !== null && !notInstalled && !canGenerate && <ImageMissingNotice providers={providers} connected={connected} onModelProviders={onModelProviders} />}
      {on && selected && <>
        <div className="grid gap-3 sm:grid-cols-2">
          {usable.length > 1 ? <label className="text-sm"><span className="text-muted-foreground">{t.imageProvider}</span>
            <select aria-label={t.imageProvider} className={select} value={selected.id} disabled={busy} onChange={event => {
              const provider = usable.find(entry => entry.id === event.target.value);
              if (!provider) return;
              const first = provider.models?.[0];
              void save({ provider: provider.id, model: first?.id ?? "", size: first?.sizes[0] ?? image.size });
            }}>
              {usable.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select>
          </label> : <div className="text-sm"><span className="text-muted-foreground">{t.imageProvider}</span><p className="mt-1 truncate" title={selected.label}>{selected.label}</p></div>}
          {models.length > 0 && <label className="text-sm"><span className="text-muted-foreground">{t.imageModel}</span>
            <select aria-label={t.imageModel} className={select} value={model?.id ?? ""} disabled={busy} onChange={event => {
              const next = models.find(entry => entry.id === event.target.value);
              const nextSize = next && next.sizes.length && !next.sizes.includes(image.size) ? next.sizes[0] : image.size;
              void save({ model: event.target.value, size: nextSize });
            }}>
              {models.map(entry => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
            </select>
          </label>}
          {sizes.length > 0 && <label className="text-sm"><span className="text-muted-foreground">{t.imageSize}</span>
            <select aria-label={t.imageSize} className={select} value={size} disabled={busy} onChange={event => void save({ size: event.target.value })}>
              {sizes.map(entry => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>}
          <label className="text-sm"><span className="text-muted-foreground">{t.imagesPerCall}</span>
            <select aria-label={t.imagesPerCall} className={select} value={image.maxImages} disabled={busy} onChange={event => void save({ maxImages: Number(event.target.value) })}>
              {MAX_IMAGES.map(max => <option key={max} value={max}>{max}</option>)}
            </select>
          </label>
        </div>
        {error != null && errorPlace === "save" && <ErrorLine raw={error} failed={t.toolsChangeFailed} onDismiss={() => setError(null)} />}
        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          {fill(t.reviewedCalls, { names: tools.reviewTools.join(", ") })}
        </div>
      </>}
    </CardContent>
  </Card>;
}