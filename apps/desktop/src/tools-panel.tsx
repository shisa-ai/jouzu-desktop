import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { explain, fill, useChatText, type ChatText } from "./chat-text";

interface ImageSettings {
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
interface ImageProvider {
  id: string;
  label: string;
  available: boolean;
  /** Why it is not usable, as a code this page words; `reason` is the original text. */
  code: string;
  reason: string;
  models: ImageModel[] | null;
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

/**
 * Tools settings. The image tool owns its provider/model/size here; nothing is
 * derived from the chat model, and the provider list and models come from the
 * extension (CLI mode) so adding a provider does not touch this page.
 */
export function ToolsPanel() {
  const t = useChatText();
  const api = useApi();
  const [tools, setTools] = useState<ToolsSettings | null>(null);
  const [providers, setProviders] = useState<ImageProvider[] | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);
  const [error, setError] = useState<unknown>(null);
  // The image tool is not installed yet: a state of the tool, not a failure (#157).
  const [notInstalled, setNotInstalled] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refreshModels(provider: string, currentModel: string, currentSize: string, base?: ToolsSettings, known?: ImageModel[] | null) {
    if (!provider) return;
    setBusy(true);
    try {
      const list = known ?? readModels((await api.tools.models(provider)).models);
      setModels(list);
      const value = base ?? tools;
      if (!value || !list.length) return;
      const selected = list.find(entry => entry.id === currentModel) ?? list[0];
      const nextSize = !selected.sizes.length || selected.sizes.includes(currentSize) ? currentSize : selected.sizes[0];
      if (selected.id !== currentModel || nextSize !== currentSize) {
        const saved = await api.tools.save({ ...value.image, provider, model: selected.id, size: nextSize }) as unknown as ToolsSettings;
        setTools(saved);
      }
    } catch (failure) {
      setError(failure);
      setModels([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const value = (await api.tools.settings()).settings as unknown as ToolsSettings;
        setTools(value);
        let list: ImageProvider[] = [];
        try {
          list = readProviders((await api.tools.providers()).providers);
        } catch (failure) {
          if ((failure as { code?: unknown } | null)?.code === "tools-unavailable") setNotInstalled(true);
          else setError(failure);
        }
        setProviders(list);
        // Only a provider that can generate images now is offered. The saved
        // one is kept when it can; otherwise the first that can takes its place.
        const usable = list.filter(provider => provider.available);
        const chosen = usable.find(provider => provider.id === value.image.provider) ?? usable[0];
        if (chosen) await refreshModels(chosen.id, chosen.id === value.image.provider ? value.image.model : "", value.image.size, value, chosen.models);
      } catch (failure) {
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
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (!tools) return <p className="text-sm text-muted-foreground">{error ? explain(t, error, t.toolsChangeFailed).text : t.loadingTools}</p>;
  const image = tools.image;
  const sizes = models.find(model => model.id === image.model)?.sizes ?? SIZES;
  const usable = (providers ?? []).filter(provider => provider.available);
  const unusable = (providers ?? []).filter(provider => !provider.available);
  const noProvider = providers !== null && !usable.length;

  return <Card className="border-border shadow-none">
    <CardHeader>
      <CardTitle>{t.imageGeneration}</CardTitle>
      <CardDescription>{t.imageGenerationHint}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="image-enabled">{t.enableImageGeneration}</Label>
        <Switch id="image-enabled" aria-label={t.enableImageGeneration} checked={image.enabled} disabled={busy} onCheckedChange={enabled => void save({ enabled })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className="text-muted-foreground">{t.imageProvider}</span>
          <select aria-label={t.imageProvider} className={select} value={noProvider ? "" : image.provider} disabled={busy || !usable.length} onChange={event => {
            const provider = usable.find(entry => entry.id === event.target.value);
            if (provider) void refreshModels(provider.id, "", "", undefined, provider.models);
          }}>
            {providers === null && <option value={image.provider}>{t.loading}</option>}
            {noProvider && <option value="">{t.noImageProvider}</option>}
            {usable.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </label>
        <label className="text-sm"><span className="text-muted-foreground">{t.imageModel}</span>
          <select aria-label={t.imageModel} className={select} value={noProvider ? "" : image.model} disabled={busy || noProvider || !models.length} onChange={event => {
            const model = models.find(entry => entry.id === event.target.value);
            const size = model && model.sizes.includes(image.size) ? image.size : model?.sizes[0];
            void save({ model: event.target.value, ...(size ? { size } : {}) });
          }}>
            {(noProvider || !models.length) && <option value={noProvider ? "" : image.model}>{noProvider || !image.model ? t.noModels : image.model}</option>}
            {!noProvider && models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
        </label>
        {sizes.length > 0 && <label className="text-sm"><span className="text-muted-foreground">{t.imageSize}</span>
          <select aria-label={t.imageSize} className={select} value={image.size} disabled={busy || noProvider} onChange={event => void save({ size: event.target.value })}>
            {sizes.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>}
        <label className="text-sm"><span className="text-muted-foreground">{t.imagesPerCall}</span>
          <select aria-label={t.imagesPerCall} className={select} value={image.maxImages} disabled={busy} onChange={event => void save({ maxImages: Number(event.target.value) })}>
            {MAX_IMAGES.map(max => <option key={max} value={max}>{max}</option>)}
          </select>
        </label>
      </div>
      {notInstalled && <p role="status" data-tools-not-installed className="text-xs text-muted-foreground">{t.codeToolsUnavailable}</p>}
      {unusable.length > 0 && <ul aria-label={t.unavailableImageProviders} className="space-y-1 text-xs text-muted-foreground">
        {unusable.map(provider => <li key={provider.id} title={provider.reason || undefined}>{provider.label}: {imageWhy(t, provider.code)}</li>)}
      </ul>}
      {error != null && <ErrorLine raw={error} failed={t.toolsChangeFailed} onDismiss={() => setError(null)} />}
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        {fill(t.reviewedCalls, { names: tools.reviewTools.join(", ") })}
      </div>
    </CardContent>
  </Card>;
}
