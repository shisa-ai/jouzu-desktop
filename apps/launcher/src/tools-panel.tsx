import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";

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
  sizes: string[];
}

const SIZES = ["1K", "2K", "4K"];
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

/**
 * Tools settings. The image tool owns its provider/model/size here; nothing is
 * derived from the chat model, and the provider list and models come from the
 * extension (CLI mode) so adding a provider does not touch this page.
 */
export function ToolsPanel() {
  const api = useApi();
  const [tools, setTools] = useState<ToolsSettings | null>(null);
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([]);
  const [models, setModels] = useState<ImageModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshModels(provider: string, currentModel: string, currentSize: string, base?: ToolsSettings) {
    if (!provider) return;
    setBusy(true);
    try {
      const result = await api.tools.models(provider);
      const list = readModels(result.models);
      setModels(list);
      const value = base ?? tools;
      if (!value || !list.length) return;
      const selected = list.find(entry => entry.id === currentModel) ?? list[0];
      const nextSize = selected.sizes.includes(currentSize) ? currentSize : selected.sizes[0];
      if (selected.id !== currentModel || nextSize !== currentSize) {
        const saved = await api.tools.save({ ...value.image, provider, model: selected.id, size: nextSize }) as unknown as ToolsSettings;
        setTools(saved);
      }
    } catch (failure) {
      setError(String(failure));
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
        try {
          const result = await api.tools.providers();
          setProviders(result.providers ?? []);
        } catch (failure) {
          setError(String(failure));
        }
        await refreshModels(value.image.provider, value.image.model, value.image.size, value);
      } catch (failure) {
        setError(String(failure));
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
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  if (!tools) return <p className="text-sm text-muted-foreground">{error ?? "Loading tools…"}</p>;
  const image = tools.image;
  const sizes = models.find(model => model.id === image.model)?.sizes ?? SIZES;

  return <Card className="border-border shadow-none">
    <CardHeader>
      <CardTitle>Image generation</CardTitle>
      <CardDescription>Defaults for the generate_image tool. The image model is independent of the chat model.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="image-enabled">Enable image generation</Label>
        <Switch id="image-enabled" aria-label="Enable image generation" checked={image.enabled} disabled={busy} onCheckedChange={enabled => void save({ enabled })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className="text-muted-foreground">Image provider</span>
          <select aria-label="Image provider" className={select} value={image.provider} disabled={busy || !providers.length} onChange={event => { const provider = event.target.value; void refreshModels(provider, "", ""); }}>
            {!providers.length && <option value={image.provider}>{image.provider}</option>}
            {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </label>
        <label className="text-sm"><span className="text-muted-foreground">Image model</span>
          <select aria-label="Image model" className={select} value={image.model} disabled={busy || !models.length} onChange={event => {
            const model = models.find(entry => entry.id === event.target.value);
            const size = model && model.sizes.includes(image.size) ? image.size : model?.sizes[0];
            void save({ model: event.target.value, ...(size ? { size } : {}) });
          }}>
            {!models.length && <option value={image.model}>{image.model || "No models"}</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
        </label>
        <label className="text-sm"><span className="text-muted-foreground">Image size</span>
          <select aria-label="Image size" className={select} value={image.size} disabled={busy} onChange={event => void save({ size: event.target.value })}>
            {sizes.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="text-sm"><span className="text-muted-foreground">Images per call</span>
          <select aria-label="Images per call" className={select} value={image.maxImages} disabled={busy} onChange={event => void save({ maxImages: Number(event.target.value) })}>
            {MAX_IMAGES.map(max => <option key={max} value={max}>{max}</option>)}
          </select>
        </label>
      </div>
      {error && <ErrorLine raw={error} failed="This tools change did not complete." onDismiss={() => setError(null)} />}
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Reviewed calls: {tools.reviewTools.join(", ")}
      </div>
    </CardContent>
  </Card>;
}
