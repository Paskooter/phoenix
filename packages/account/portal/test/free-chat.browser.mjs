import test from 'node:test';
import assert from 'node:assert/strict';
import { openConsole, VIEWPORTS } from './console-browser-fixture.mjs';
import { BY_KEY } from '../../src/admin/configCatalog.js';

test('Free AI chat has a default-on catalog entry and account toggle with short/detailed choice', async () => {
  assert.equal(BY_KEY.get('PHOENIX_FREE_CHAT_ENABLED')?.default, 'true');
  const f = await openConsole({ viewport: VIEWPORTS.desktop });
  try {
    await f.navigate('#/profile');
    const panel = f.page.locator('[data-free-chat]');
    await panel.waitFor();
    assert.equal(await panel.locator('input[name="freeChatEnabled"]').isChecked(), true);
    await panel.locator('label.switch').click();
    await panel.locator('select[name="freeChatDetail"]').selectOption('detailed');
    await panel.getByRole('button', { name: 'Save chat settings', exact: true }).click();
    await panel.locator('[role="status"]').filter({ hasText: 'Chat settings saved' }).waitFor();
    await f.navigate('#/profile');
    assert.equal(await f.page.locator('[data-free-chat] input[name="freeChatEnabled"]').isChecked(), false);
    assert.equal(await f.page.locator('[data-free-chat] select').inputValue(), 'detailed');
    for (const [label, size] of Object.entries(VIEWPORTS)) {
      await f.page.setViewportSize(size);
      await f.page.locator('[data-free-chat]').scrollIntoViewIfNeeded();
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.FREE_CHAT_SCREENSHOTS) await f.page.locator('[data-free-chat]').screenshot({ path: process.env.FREE_CHAT_SCREENSHOTS + '/console-' + label + '.png' });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
