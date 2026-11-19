import { test, expect, type Page } from '@playwright/test';
import { UI_BASE, stubHostControl, emptyControlState } from './host-control';

// ui-layer §8: an error is shown at the scope of what failed. A settings
// operation for one provider (its key, sign-in, removal or default model) is
// that provider's: the shared connection form shows it only while it shows that
// provider. The host keeps the result until the next operation of its kind
// (host-layer §6.1), so after a reload it is still that provider's, and only
// that provider's.

const state = {
  ...emptyControlState,
  providers: [
    { id: 'fixture', name: 'Fixture', apiKey: true },
    { id: 'openai', name: 'OpenAI', apiKey: true },
  ],
};
const writeError = 'settings.json: EPERM (open)';

async function openForm(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add provider', exact: true }).click();
  return dialog;
}

async function choose(page: Page, name: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Service', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

test('a default model that was not saved is shown on its provider only', async ({ page }) => {
  await stubHostControl(page, body => { if (body.action === 'default-model') throw new Error(writeError); return state; });
  await page.addInitScript(() => localStorage.setItem('jouzu.ui.language', 'en'));
  await page.goto(UI_BASE);
  const dialog = await openForm(page);
  await choose(page, 'Fixture');
  await dialog.getByRole('combobox', { name: 'Default model', exact: true }).click();
  await page.getByRole('option', { name: 'Fixture model', exact: true }).click();
  const alert = dialog.getByRole('alert').filter({ hasText: 'The default model was not saved.' });
  await expect(alert).toBeVisible();

  await choose(page, 'OpenAI');
  await expect(alert).toHaveCount(0);
  await choose(page, 'Fixture');
  await expect(alert).toBeVisible();

  // After a reload the result is still the host's, and still Fixture's.
  await page.reload();
  const again = await openForm(page);
  await choose(page, 'OpenAI');
  await expect(again.getByRole('alert')).toHaveCount(0);
  await choose(page, 'Fixture');
  const kept = again.getByRole('alert').filter({ hasText: 'The default model was not saved.' });
  await expect(kept).toBeVisible();
  await kept.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(kept.getByText(writeError)).toBeVisible();
});

test('a key that was not saved is shown on its provider only', async ({ page }) => {
  await stubHostControl(page, body => { if (body.action === 'provider-key') throw new Error('Could not save the provider key.'); return state; });
  await page.addInitScript(() => localStorage.setItem('jouzu.ui.language', 'en'));
  await page.goto(UI_BASE);
  const dialog = await openForm(page);
  await choose(page, 'OpenAI');
  await dialog.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-test');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const alert = dialog.getByRole('alert').filter({ hasText: 'The provider key was not saved.' });
  await expect(alert).toBeVisible();
  await choose(page, 'Fixture');
  await expect(alert).toHaveCount(0);
  await choose(page, 'OpenAI');
  await expect(alert).toBeVisible();
});
