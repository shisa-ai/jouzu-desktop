import { test, expect } from '@playwright/test';
import { UI_BASE, stubHostControl, emptyControlState } from './host-control';

// A failed settings operation is worded by the interface, in its language, from
// the operation it was (ui-layer §8). What the configuration adapter wrote is the
// original text: it is kept, under Details, never shown as the message.

const adapterText = 'Models could not be refreshed. Sign in to Shisa.AI again or add a provider key.';

for (const [locale, expected] of [
  ['en', 'The models were not refreshed. Sign in to Shisa.AI again or add a provider key.'],
  ['ja', 'モデルは更新されませんでした。Shisa.AI に再度サインインするか、プロバイダーのキーを追加してください。'],
  ['zh-Hans', '模型未刷新。请重新登录 Shisa.AI，或添加提供方密钥。'],
] as const) {
  test(`a failed model refresh is worded in ${locale}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('jouzu.ui.language', value), locale);
    const signedIn = { ...emptyControlState, account: { signedIn: true } };
    await stubHostControl(page, body => { if (body.action === 'refresh-catalogs') throw new Error(adapterText); return signedIn; });
    await page.goto(UI_BASE);
    await page.getByRole('button', { name: { en: 'Settings', ja: '設定', 'zh-Hans': '设置' }[locale], exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: { en: 'Refresh models', ja: 'モデルを更新', 'zh-Hans': '刷新模型' }[locale], exact: true }).click();
    const alert = dialog.getByRole('alert').filter({ hasText: expected });
    await expect(alert).toBeVisible();
    await expect(alert.getByText(adapterText)).toHaveCount(0);
    await alert.getByRole('button', { name: { en: 'Details', ja: '詳細', 'zh-Hans': '详情' }[locale], exact: true }).click();
    await expect(alert.getByText(adapterText)).toBeVisible();
  });
}
