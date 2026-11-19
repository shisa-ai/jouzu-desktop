import { test, expect, type Page } from '@playwright/test';
import { UI_BASE, emptyControlState, stubHostControl } from './host-control';

// Issue #91: Settings → Web access shows who may connect, lets the user choose
// this computer and trusted networks, pair a device and remove paired devices.
// The host side (listeners, pairing, refusal) is covered by the host's own tests;
// here the /v1/web-access contract is answered at the network boundary.

type Device = { id: string; name: string; network: string; createdAt: string; lastSeen: string | null };

function webHost() {
  const model = {
    mode: 'off' as 'off' | 'local' | 'networks',
    port: null as number | null,
    enabled: [] as string[],
    devices: [] as Device[],
    pairing: false,
    requests: [] as Array<{ method: string; path: string; body?: unknown }>,
  };
  const interfaces = [
    { name: 'Wi-Fi', address: '192.168.1.20', kind: 'lan' },
    { name: 'Tailscale', address: '100.101.102.103', kind: 'tailnet' },
  ];
  const snapshot = () => ({
    mode: model.mode,
    port: model.port,
    secure: false,
    localUrl: model.mode !== 'off' ? `http://127.0.0.1:${model.port}/` : null,
    localError: null,
    networks: interfaces.map(item => {
      const enabled = model.mode === 'networks' && model.enabled.includes(item.name);
      return { ...item, enabled, url: enabled ? `http://${item.address}:${model.port}/` : null, error: null };
    }),
    unavailableNetworks: [],
    devices: model.devices,
    pairing: model.pairing,
  });
  return { model, snapshot, async route(page: Page) {
    await page.route('**/v1/web-access**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() : undefined;
      model.requests.push({ method, path, body });
      const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (path === '/v1/web-access' && method === 'PUT') {
        model.mode = body.mode; model.enabled = body.networks; model.port = model.port ?? 51234;
        return json(snapshot());
      }
      if (path === '/v1/web-access/pairing' && method === 'POST') {
        model.pairing = true;
        const links = [{ network: 'This computer', url: `http://127.0.0.1:${model.port}/pair?code=ABCD2345` }, ...model.enabled.map(name => {
          const item = interfaces.find(entry => entry.name === name)!;
          return { network: name, url: `http://${item.address}:${model.port}/pair?code=ABCD2345` };
        })];
        return json({ code: 'ABCD2345', expiresInSeconds: 300, links });
      }
      if (path === '/v1/web-access/pairing' && method === 'DELETE') { model.pairing = false; return route.fulfill({ status: 204, body: '' }); }
      if (path.startsWith('/v1/web-access/devices/') && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/').pop()!);
        model.devices = model.devices.filter(device => device.id !== id);
        return json(snapshot());
      }
      if (path === '/v1/web-access/devices' && method === 'DELETE') { model.devices = []; return json(snapshot()); }
      return json(snapshot());
    });
  } };
}

async function open(page: Page) {
  await stubHostControl(page, () => emptyControlState);
  const host = webHost();
  await host.route(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    localStorage.setItem('jouzu.ui.language', 'en');
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === 'shell_state') return { ready: true, bash: true, recent: [], platform: 'windows' };
        if (command === 'component_versions') return { jouzu: '0.2.5', development: true };
        if (command === 'environment_read') return [];
        if (command.includes('version')) return '0.1.0';
        return 1;
      },
    };
  });
  await page.goto(UI_BASE);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Web access' }).click();
  return { dialog, host };
}

test('web access is off by default and says who can connect', async ({ page }) => {
  const { dialog, host } = await open(page);
  await expect(dialog.getByRole('combobox', { name: 'Who can connect' })).toHaveText('Off');
  await expect(dialog.getByText('Browsers and other devices cannot connect.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Pair a device' })).toHaveCount(0);
  expect(host.model.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('trusted networks are chosen explicitly, then a device is paired and removed', async ({ page }) => {
  const { dialog, host } = await open(page);
  await dialog.getByRole('combobox', { name: 'Who can connect' }).click();
  await page.getByRole('option', { name: 'This computer and trusted networks' }).click();
  // Nothing is saved until a network is chosen.
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByRole('switch', { name: 'Tailscale' }).click();
  await expect(dialog.getByText(/not encrypted/)).toHaveCount(0);
  await dialog.getByRole('switch', { name: 'Wi-Fi' }).click();
  await expect(dialog.getByText(/Traffic on a local network is not encrypted/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText(/Serving at: http:\/\/127\.0\.0\.1:51234\//)).toBeVisible();
  expect(host.model.requests.find(request => request.method === 'PUT')?.body).toEqual({ mode: 'networks', networks: ['Tailscale', 'Wi-Fi'] });

  await dialog.getByRole('button', { name: 'Pair a device' }).click();
  await expect(dialog.getByLabel('Pairing code')).toHaveText('ABCD2345');
  await expect(dialog.getByRole('img', { name: 'Pair a device: Tailscale' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Wi-Fi' })).toHaveValue('http://192.168.1.20:51234/pair?code=ABCD2345');
  await page.screenshot({ path: test.info().outputPath('web-access-pairing.png') });

  // The device pairs on its side; the page notices and closes the code.
  host.model.devices.push({ id: 'dev1', name: 'Safari on iPhone', network: 'Wi-Fi', createdAt: '2026-11-15T14:00:00Z', lastSeen: '2026-11-15T14:00:00Z' });
  await expect(dialog.getByText('Paired: Safari on iPhone')).toBeVisible({ timeout: 5000 });
  await expect(dialog.getByLabel('Pairing code')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('web-access-devices.png') });

  await dialog.getByRole('button', { name: 'Remove Safari on iPhone' }).click();
  await expect(dialog.getByText('No device is paired yet.')).toBeVisible();
  expect(host.model.requests.some(request => request.method === 'DELETE' && request.path === '/v1/web-access/devices/dev1')).toBe(true);
});
