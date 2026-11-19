import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { ArrowUpRight, Copy, Link2, Trash2 } from "lucide-react";
import { useApi } from "./api/context";
import type { WebAccessMode, WebAccessPairing, WebAccessState } from "./api/jouzu-api";
import type { Locale } from "./i18n";
import { webAccessText as text } from "./web-access-text";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { copyText } from "./secure-context";


export const webAccessTitle = (locale: Locale) => text[locale].title;

/** A QR code drawn as one SVG path; no network request, no canvas. */
function QrCode({ value, label }: { value: string; label: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { d, size: count + 8 };
  }, [value]);
  return <svg role="img" aria-label={label} viewBox={`0 0 ${path.size} ${path.size}`} className="size-40 shrink-0 rounded-md bg-white" shapeRendering="crispEdges"><path d={path.d} fill="#000" /></svg>;
}

/** Settings → Web access (issue #91): scope, trusted networks, pairing and paired devices. */
export function WebAccessSection({ locale, openUrl, confirm }: { locale: Locale; openUrl: (url: string) => Promise<void>; confirm: (message: string) => Promise<boolean> }) {
  const api = useApi();
  const t = text[locale];
  const [state, setState] = useState<WebAccessState | null>(null);
  const [mode, setMode] = useState<WebAccessMode>("off");
  const [networks, setNetworks] = useState<string[]>([]);
  const [pairing, setPairing] = useState<(WebAccessPairing & { devices: number; until: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);

  const adopt = useCallback((next: WebAccessState) => {
    setState(next);
    setMode(next.mode);
    setNetworks([...next.networks.filter(network => network.enabled).map(network => network.name), ...next.unavailableNetworks]);
  }, []);

  useEffect(() => {
    let live = true;
    api.settings.webAccess.read().then(next => { if (live) adopt(next); }).catch(failure => { if (live) setError(failure); });
    return () => { live = false; };
  }, [api, adopt]);

  // While a pairing code is open, watch for the new device and for expiry.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= pairing.until) { setPairing(null); return; }
      api.settings.webAccess.read().then(next => {
        setState(next);
        if (next.devices.length > pairing.devices) {
          setPaired(next.devices[next.devices.length - 1]?.name ?? null);
          setPairing(null);
        }
      }).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [api, pairing]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };

  const saved = state ? state.mode === mode && (mode !== "networks" || sameSet(networks, [...state.networks.filter(network => network.enabled).map(network => network.name), ...state.unavailableNetworks])) : true;
  const lanOn = mode === "networks" && state?.networks.some(network => network.kind === "lan" && networks.includes(network.name));
  const failures = state ? [...(state.localError && state.port ? [`127.0.0.1:${state.port} (${state.localError})`] : []), ...state.networks.filter(network => network.enabled && network.error).map(network => `${network.name} ${network.address} (${network.error})`)] : [];
  const urls = state ? [state.localUrl, ...state.networks.map(network => network.url)].filter((url): url is string => !!url) : [];

  return <Card className="border-border shadow-none">
    <CardHeader><CardTitle>{t.title}</CardTitle><CardDescription>{t.hint}</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      {error !== null && <ErrorLine raw={error} failed={t.failed} onDismiss={() => setError(null)} />}
      <div className="space-y-2">
        <Label htmlFor="web-access-scope">{t.scope}</Label>
        <Select value={mode} disabled={busy || !state} onValueChange={value => setMode(value as WebAccessMode)}>
          <SelectTrigger id="web-access-scope" aria-label={t.scope} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="off">{t.off}</SelectItem><SelectItem value="local">{t.local}</SelectItem><SelectItem value="networks">{t.networks}</SelectItem></SelectContent>
        </Select>
        <p className="text-sm leading-relaxed text-muted-foreground">{mode === "off" ? t.offHint : mode === "local" ? t.localHint : t.networksHint}</p>
      </div>
      {mode === "networks" && state && <div className="space-y-2">
        <p className="text-sm font-medium">{t.trusted}</p>
        {state.networks.length === 0 && <p className="text-sm text-muted-foreground">{t.noNetworks}</p>}
        {state.networks.map(network => <div key={network.name} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0"><p className="truncate text-sm">{network.name}</p><p className="text-xs text-muted-foreground">{network.kind === "tailnet" ? t.tailnet : t.lan} · {network.address}</p></div>
          <Switch aria-label={network.name} disabled={busy} checked={networks.includes(network.name)} onCheckedChange={on => setNetworks(list => on ? [...list, network.name] : list.filter(name => name !== network.name))} />
        </div>)}
        {state.unavailableNetworks.length > 0 && <p className="text-sm text-muted-foreground">{t.unavailable} {state.unavailableNetworks.join(", ")}</p>}
        {lanOn && <p className="text-sm leading-relaxed text-muted-foreground">{t.plainLan}</p>}
      </div>}
      {!saved && <div className="flex justify-end"><Button disabled={busy || (mode === "networks" && networks.length === 0)} onClick={() => void run(async () => { setPairing(null); adopt(await api.settings.webAccess.update({ mode, networks: mode === "networks" ? networks.filter(name => state?.networks.some(network => network.name === name)) : [] })); })}>{t.save}</Button></div>}
      {saved && state && state.mode !== "off" && <div className="space-y-1">
        {urls.length > 0 && <p className="text-sm text-muted-foreground">{t.serving}: {urls.join(" · ")}</p>}
        {failures.length > 0 && <p role="status" className="text-sm text-destructive">{t.notServing} {failures.join(" · ")}</p>}
      </div>}

      {saved && state && state.mode !== "off" && <div className="space-y-3 border-t border-border pt-5">
        {!pairing && <div className="flex items-center justify-between gap-3">
          {paired ? <p role="status" className="text-sm text-muted-foreground">{t.done}: {paired}</p> : <span />}
          <Button variant="outline" disabled={busy || urls.length === 0} onClick={() => void run(async () => {
            setPaired(null);
            const next = await api.settings.webAccess.pair();
            setPairing({ ...next, devices: state.devices.length, until: Date.now() + next.expiresInSeconds * 1000 });
          })}><Link2 />{t.pair}</Button>
        </div>}
        {pairing && <div className="space-y-4 rounded-lg border border-border p-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{t.pairHint} {Math.round(pairing.expiresInSeconds / 60)} {t.expires}</p>
          <p className="text-center font-mono text-2xl tracking-[0.3em]" aria-label={t.code}>{pairing.code}</p>
          {pairing.links.map(link => <div key={link.url} className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <QrCode value={link.url} label={`${t.pair}: ${link.network}`} />
            <div className="w-full min-w-0 space-y-2">
              <p className="text-sm font-medium">{link.network}</p>
              <Input readOnly aria-label={link.network} value={link.url} onFocus={event => event.target.select()} />
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => void copyText(link.url).then(() => setCopied(link.url)).catch(failure => setError(failure))}><Copy />{copied === link.url ? t.copied : t.copy}</Button>
                {new URL(link.url).hostname === "127.0.0.1" && <Button variant="outline" onClick={() => void openUrl(link.url).catch(failure => setError(failure))}><ArrowUpRight />{t.open}</Button>}
              </div>
            </div>
          </div>)}
          <div className="flex justify-end"><Button variant="ghost" onClick={() => void run(async () => { setPairing(null); await api.settings.webAccess.cancelPairing(); })}>{t.cancel}</Button></div>
        </div>}
      </div>}

      {state && (state.devices.length > 0 || state.mode !== "off") && <div className="space-y-2 border-t border-border pt-5">
        <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{t.devices}</p>
          {state.devices.length > 1 && <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { if (await confirm(t.confirmRemoveAll)) adopt(await api.settings.webAccess.revoke()); })}>{t.removeAll}</Button>}</div>
        {state.devices.length === 0 && <p className="text-sm text-muted-foreground">{t.noDevices}</p>}
        {state.devices.map(device => <div key={device.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0"><p className="truncate text-sm">{device.name}</p><p className="text-xs text-muted-foreground">{device.network} · {t.lastSeen}: {device.lastSeen ? new Date(device.lastSeen).toLocaleString() : t.never}</p></div>
          <Button variant="ghost" aria-label={`${t.remove} ${device.name}`} disabled={busy} onClick={() => void run(async () => { adopt(await api.settings.webAccess.revoke(device.id)); })}><Trash2 />{t.remove}</Button>
        </div>)}
      </div>}
    </CardContent>
  </Card>;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(value => b.includes(value));
}
