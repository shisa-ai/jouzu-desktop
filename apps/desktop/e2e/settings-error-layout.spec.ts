import { test, expect, type Locator, type Page } from '@playwright/test';
import { UI_BASE, stubHostControl, emptyControlState } from './host-control';

// ui-layer §1/§8 (#147): showing or clearing a settings error never moves the
// panel. The tabs and the first card stay exactly where they were.

async function openSettings(page: Page) {
  await page.addInitScript(() => localStorage.setItem('jouzu.ui.language', 'en'));
  await page.goto(UI_BASE);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const top = async (locator: Locator) => (await locator.boundingBox())!.y;

async function expectNoShift(dialog: Locator, alert: Locator) {
  const tab = dialog.getByRole('tab').first();
  const panel = dialog.getByRole('tabpanel');
  await expect(alert).toBeVisible();
  const withError = [await top(tab), await top(panel)];
  await alert.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(alert).toHaveCount(0);
  expect([await top(tab), await top(panel)]).toEqual(withError);
}

test('a failed settings action does not move the panel', async ({ page }) => {
  await stubHostControl(page, () => emptyControlState);
  // Registered after the stub, so it answers first: reading the environment fails.
  await page.route('**/v1/environment', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'disk read failed' } }) }));
  const dialog = await openSettings(page);
  await expectNoShift(dialog, dialog.getByRole('alert'));
});

test('settings that cannot be read do not move the panel', async ({ page }) => {
  await stubHostControl(page, body => { if (body.action === 'status') throw new Error('control unavailable'); return emptyControlState; });
  await page.route('**/v1/environment', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }) }));
  const dialog = await openSettings(page);
  await expectNoShift(dialog, dialog.getByRole('alert').filter({ hasText: "Jouzu's settings could not be read. Nothing was changed." }));
});

test('a failed action on a card does not move that card or the cards below', async ({ page }) => {
  await stubHostControl(page, body => { if (body.action === 'shisa-login') throw new Error('sign-in refused'); return emptyControlState; });
  const dialog = await openSettings(page);
  const signIn = dialog.getByRole('button', { name: 'Sign in to Shisa.AI', exact: true });
  const add = dialog.getByRole('button', { name: 'Add provider', exact: true });
  const before = [await top(signIn), await top(add)];
  await signIn.click();
  const alert = dialog.getByRole('alert').filter({ hasText: 'Sign-in to Shisa.AI did not complete.' });
  await expect(alert).toBeVisible();
  expect([await top(signIn), await top(add)]).toEqual(before);
  await alert.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(alert).toHaveCount(0);
  expect([await top(signIn), await top(add)]).toEqual(before);
});
