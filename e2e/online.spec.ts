import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { getJewel } from '../src/game/catalog';
import { COST_COLORS, TOKEN_COLORS, type Action } from '../src/game/types';
import type { RoomSnapshot } from '../src/online/protocol';

const localConfig = existsSync('.qa/e2e-env.json') ? JSON.parse(readFileSync('.qa/e2e-env.json', 'utf8')) : {};
const hostUrl = process.env.E2E_HOST_URL ?? localConfig.host ?? 'http://127.0.0.1:3003';
const guestUrl = process.env.E2E_GUEST_URL ?? localConfig.guest ?? hostUrl;
async function artworkReady(page: Page, completed: Set<string>) {
  const urls = await page.evaluate(() => {
    const urls = new Set<string>();
    for (const element of document.querySelectorAll('.game-table, .game-table *')) {
      if (!element.getBoundingClientRect().width || !element.getBoundingClientRect().height) continue;
      for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)) urls.add(match[1] ?? match[2] ?? match[3]);
    }
    return [...urls].filter(url => !url.startsWith('data:'));
  });
  await expect.poll(() => urls.filter(url => !completed.has(url)), { timeout: 180000, message: 'Visible artwork must finish its real browser requests' }).toEqual([]);
}
function observe(page: Page) {
  let snapshot: RoomSnapshot | undefined;
  const errors: string[] = [];
  const sockets: string[] = [];
  const images = new Set<string>();
  page.on('requestfinished', async request => {
    if (request.resourceType() === 'image' && (await request.response())?.ok()) images.add(request.url());
  });
  let imageResponses = 0;
  page.on('response', response => {
    if (response.request().resourceType() === 'image' && ++imageResponses <= 3) console.log(`Image response: ${response.headers()['content-type']} ${response.headers()['content-length']} bytes`);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => console.log(`Request failed: ${new URL(request.url()).pathname} ${request.failure()?.errorText}`));
  page.on('websocket', socket => { sockets.push(socket.url()); socket.on('framereceived', ({ payload }) => {
    const text = String(payload);
    if (text.startsWith('42[')) {
      const event = JSON.parse(text.slice(2));
      if (event[0] === 'state') snapshot = event[1];
    }
  }); });
  return { state: () => snapshot!, errors, sockets, images };
}
async function operate(page: Page, state: RoomSnapshot, action: Action) {
  await expect(page.locator('.online-toolbar')).toContainText('已连接');
  const controls = page.locator('.action-controls');
  if (action.type === 'takeTokens') {
    for (const index of action.indices) await page.locator('.board-cell').nth(index).click();
    await controls.getByRole('button', { name: /确认拿取/ }).click();
  } else if (action.type === 'reserve' || action.type === 'buy') {
    const source = action.source;
    if (source.kind === 'deck') await page.getByRole('button', { name: `盲预留 ${source.level} 级牌库` }).click();
    else if (source.kind === 'market') await page.locator(`.market [data-card-id="${state.view.market[source.level][source.index]}"]`).click();
    else {
      await page.locator('.tray-reserve').click();
      await page.locator('.online-drawer [data-card-id]').nth(source.index).click();
    }
    if (action.type === 'reserve') {
      const toggle = controls.getByRole('button', { name: '改为预留', exact: true });
      if (await toggle.isVisible()) await toggle.click();
      await page.locator('.board-cell').nth(action.goldIndex).click();
      await controls.getByRole('button', { name: '确认预留', exact: true }).click();
    } else await controls.getByRole('button', { name: '确认购买', exact: true }).click();
  } else if (action.type === 'refill') await page.getByRole('button', { name: '补盘', exact: true }).click();
  else if (action.type === 'usePrivilege') {
    await page.getByRole('button', { name: '使用特权', exact: true }).click();
    await page.locator('.board-cell').nth(action.index).click();
  } else if (action.type === 'takeBonusToken') await page.locator('.board-cell').nth(action.index).click();
  else if (action.type === 'chooseRoyal') await page.locator(`[data-royal-id="${action.cardId}"]`).click();
  else if (action.type === 'chooseColor' || action.type === 'stealToken') await controls.locator(`button:has(.gem-${action.color})`).click();
  else if (action.type === 'discard') {
    const colors = TOKEN_COLORS.filter(color => state.view.players[state.seat].tokens[color] > 0);
    for (const [index, color] of colors.entries()) await controls.locator('input').nth(index).fill(String(action.tokens[color]));
    await controls.getByRole('button', { name: /确认归还/ }).click();
  }
}
// A visible-information driver chooses legal actions; all actions go through rendered controls.
function choose(state: RoomSnapshot): Action {
  const { view, legal, seat } = state;
  const me = view.players[seat];
  if (view.pending) return legal[0];
  const cardOf = (action: Extract<Action, { type: 'buy' }>) => getJewel(action.source.kind === 'market' ? view.market[action.source.level][action.source.index]! : me.reserved[(action.source as { index: number }).index]!);
  const buys = legal.filter((a): a is Extract<Action, { type: 'buy' }> => a.type === 'buy');
  if (buys.length) return buys.sort((a,b) => { const x = cardOf(a), y = cardOf(b); return (y.points * 4 + y.crowns * 3 + (y.bonus?.amount ?? 0) * 2) - (x.points * 4 + x.crowns * 3 + (x.bonus?.amount ?? 0) * 2); })[0];
  const cards = [...Object.values(view.market).flat(), ...me.reserved].filter((id): id is string => !!id).map(getJewel);
  const need = (card: typeof cards[number], extra: string[] = []) => Math.max(0, COST_COLORS.reduce((sum, color) => sum + Math.max(0, card.cost[color] - (color === 'pearl' ? 0 : me.stats.bonuses[color]) - me.tokens[color] - extra.filter(x => x === color).length), 0) - me.tokens.gold);
  const target = cards.sort((a,b) => (need(a) - .15 * a.points) - (need(b) - .15 * b.points))[0];
  const takes = legal.filter((a): a is Extract<Action, { type: 'takeTokens' }> => a.type === 'takeTokens');
  if (takes.length) return takes.sort((a,b) => {
    const score = (a: typeof takes[number]) => (target ? need(target) - need(target, a.indices.map(i => view.board[i]!)) : 0) * 10 + a.indices.length;
    return score(b) - score(a);
  })[0];
  return legal.find(a => a.type === 'refill') ?? legal[0];
}

test('two browser players create, join, hide cards, reconnect and finish a match', async ({ browser }, info) => {
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1600, height: 1000 } }), browser.newContext({ viewport: { width: 1600, height: 1000 } })]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const observed = pages.map(observe);
  try {
    await pages[0].goto(hostUrl + '/#online');
    await pages[0].getByRole('button', { name: '创建房间 · Asuka', exact: true }).click();
    await expect.poll(() => observed[0].state()?.code, { timeout: 30000 }).toBeTruthy();
    const code = observed[0].state().code;
    await pages[1].goto(guestUrl + '/#online');
    await expect(pages[1].getByLabel('邀请码', { exact: true })).toBeVisible({ timeout: 120000 });
    await pages[1].getByLabel('邀请码', { exact: true }).fill(code);
    await pages[1].getByRole('button', { name: '加入房间 · Sinji', exact: true }).click();
    await expect.poll(() => observed[0].state()?.ready, { timeout: 30000 }).toBe(true);
    await expect.poll(() => observed[1].state()?.ready, { timeout: 30000 }).toBe(true);
    console.log('Both players joined; loading visible artwork.');
    await artworkReady(pages[1], observed[1].images);
    await pages[1].screenshot({ path: info.outputPath('01-joined.png') });
    for (const page of pages) for (const row of await page.locator('.seat-resource-grid .resource-count').all()) {
      const icon = await row.locator('.gem').boundingBox(), number = await row.locator('b').boundingBox();
      expect(icon!.x + icon!.width).toBeLessThanOrEqual(number!.x + .5);
    }
    const initial = observed[0].state().view.turn;
    const blind = observed[initial].state().legal.find(a => a.type === 'reserve' && a.source.kind === 'deck')!;
    await operate(pages[initial], observed[initial].state(), blind);
    await expect.poll(() => observed[0].state().view.revision).toBe(1);
    await expect.poll(() => observed[1].state().view.revision).toBe(1);
    expect(observed[initial === 0 ? 1 : 0].state().view.players[initial].reserved).toEqual([null]);
    // Drop the actual guest browser's network, then recover the same seat and board.
    await contexts[1].setOffline(true);
    await expect(pages[1].locator('.online-toolbar')).toContainText('重连中', { timeout: 60000 });
    await expect(pages[1].locator('.board-cell:not(:disabled)')).toHaveCount(0);
    await pages[1].screenshot({ path: info.outputPath('02-offline.png') });
    await contexts[1].setOffline(false);
    await expect(pages[1].locator('.online-toolbar')).toContainText('已连接', { timeout: 60000 });
    await pages[1].reload();
    await expect(pages[1].locator('.online-toolbar')).toContainText(code, { timeout: 30000 });
    await expect(pages[1].locator('.online-toolbar')).toContainText('已连接');
    expect(observed[1].state().view.revision).toBe(1);
    console.log('Network disconnect, reconnect and page refresh passed.');
    const downloading = pages[1].waitForEvent('download');
    await pages[1].getByRole('button', { name: '保存重连凭证', exact: true }).click();
    const backup = await downloading;
    const credential = await readFile((await backup.path())!);
    expect(observed[1].errors).toEqual([]);
    await contexts[1].close();
    contexts[1] = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    pages[1] = await contexts[1].newPage(); observed[1] = observe(pages[1]);
    await pages[1].goto(guestUrl + '/#online');
    await expect(pages[1].locator('input[type=file]')).toBeAttached({ timeout: 120000 });
    await pages[1].locator('input[type=file]').setInputFiles({ name: 'reconnect.json', mimeType: 'application/json', buffer: credential });
    await expect(pages[1].locator('.online-toolbar')).toContainText(code, { timeout: 30000 });
    await expect(pages[1].locator('.online-toolbar')).toContainText('已连接');
    expect(observed[1].state().view.revision).toBe(1);
    console.log('Credential import into a fresh browser passed.');
    await artworkReady(pages[1], observed[1].images);
    await pages[1].setViewportSize({ width: 1366, height: 768 });
    await pages[1].screenshot({ path: info.outputPath('03-reconnected-1366.png') });
    await pages[1].setViewportSize({ width: 1600, height: 1000 });
    const kinds = new Set<string>(['reserve']);
    for (let step = 1; step < 450 && observed[0].state().view.winner === null; step++) {
      const actor = observed[0].state().view.turn;
      await expect.poll(() => observed[actor].state().view.revision).toBe(step);
      const state = observed[actor].state();
      const action = !kinds.has('usePrivilege') ? state.legal.find(a => a.type === 'usePrivilege') ?? choose(state) : choose(state);
      kinds.add(action.type);
      await operate(pages[actor], state, action);
      for (const watcher of observed) await expect.poll(() => watcher.state().view.revision, { timeout: 30000 }).toBe(step + 1);
      if (step % 25 === 0) console.log(`UI moves committed: ${step + 1}`);
    }
    expect(observed[0].state().view.winner).not.toBeNull();
    expect(observed[0].state().view.winner).toBe(observed[1].state().view.winner);
    await artworkReady(pages[1], observed[1].images);
    await pages[1].screenshot({ path: info.outputPath('04-finished.png') });
    await pages[1].getByRole('button', { name: '胜率回放', exact: true }).click();
    await expect(pages[1].getByRole('heading', { name: '对局回放' })).toBeVisible({ timeout: 30000 });
    await pages[1].screenshot({ path: info.outputPath('05-replay.png') });
    expect(observed.flatMap(watcher => watcher.errors)).toEqual([]);
    expect(observed[1].sockets.some(url => new URL(url).host === new URL(guestUrl).host)).toBe(true);
    console.log(JSON.stringify({ steps: observed[0].state().view.revision, actionKinds: [...kinds], urls: { host: hostUrl, guest: guestUrl }, pageErrors: 0 }));
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
