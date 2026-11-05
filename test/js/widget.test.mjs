import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TileRequests } from '../../src/higlass/tile-requests.js';

/** Load the production widget with only HiGlass/DOM imports replaced. */
const source = (await readFile(new URL('../../src/higlass/widget.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default {', 'const widget = {');
const window = {};
const scope = vm.runInNewContext(`${source}\n({ registerJupyterHiGlassDataFetcher, resolveJupyterServers, widget })`, {
  TileRequests, window, crypto, AbortController, console,
  hglib: { CSS: '', NOTEBOOK_TILE_PROTOCOL: 1 },
  CSSStyleSheet: class { replaceSync() {} },
});

/** Fake comm with observable listener ownership. */
function model() {
  const listeners = new Set(); const sent = [];
  return { sent, listeners, on: (_, fn) => listeners.add(fn), off: (_, fn) => listeners.delete(fn),
    send: (msg) => sent.push(msg),
    reply(msg, payload) { for (const fn of [...listeners]) fn({ id: msg.id, payload }); },
  };
}
/** Return a widget that refers to the selected client. */
function owner(client) {
  return { get: () => 'IPY_MODEL_client', widget_manager: { get_model: async () => client } };
}
const hgc = {
  dataFetchers: { DataFetcher: class {} },
  services: { tileResponseToData: (payload) => payload },
};

test('two widgets share requests but maintain separate lifetimes and client routing', async () => {
  const client = model(); const independent = model();
  const a = await scope.registerJupyterHiGlassDataFetcher(owner(client));
  const b = await scope.registerJupyterHiGlassDataFetcher(owner(client));
  const c = await scope.registerJupyterHiGlassDataFetcher(owner(independent));
  const make = (registration) => new window.higlassDataFetchersByType[registration.name].dataFetcher(hgc, { tilesetUid: 'uid' });
  const fa = make(a); const fb = make(b); const fc = make(c);
  fa.setVisibleTiles(['0.0']); fb.setVisibleTiles(['0.0']); fc.setVisibleTiles(['0.0']);
  let count = 0;
  const pa = fa.fetchTilesDebounced(() => { throw new Error('disposed widget callback'); }, ['0.0']);
  const pb = fb.fetchTilesDebounced(() => count++, ['0.0']);
  const pc = fc.fetchTilesDebounced(() => count++, ['0.0']);
  await delay(0); a.dispose();
  assert.equal(client.sent.length, 1);
  assert.equal(independent.sent.length, 1);
  client.reply(client.sent[0], { 'uid.0.0': { dense: [1] } });
  independent.reply(independent.sent[0], { 'uid.0.0': { dense: [2] } });
  await Promise.all([pa, pb, pc]);
  assert.equal(count, 2);
  b.dispose(); c.dispose();
  assert.equal(Object.keys(window.higlassDataFetchersByType).length, 0);
  assert.equal(client.listeners.size, 0);
});

test('fast sibling delivers before slow reply and missing responses reject', async () => {
  const client = model(); const reg = await scope.registerJupyterHiGlassDataFetcher(owner(client));
  const f = new window.higlassDataFetchersByType[reg.name].dataFetcher(hgc, { tilesetUid: 'uid' });
  f.setVisibleTiles(['0.0', '0.1']); const delivered = [];
  const request = f.fetchTilesDebounced((tiles) => delivered.push(...Object.keys(tiles)), ['0.0', '0.1']);
  const rejected = assert.rejects(request, /missing response/);
  await delay(0);
  const fast = client.sent.find((msg) => msg.payload.tileIds[0] === 'uid.0.1');
  const slow = client.sent.find((msg) => msg.payload.tileIds[0] === 'uid.0.0');
  client.reply(fast, { 'uid.0.1': { dense: [1] } }); await delay(0);
  assert.deepEqual(delivered, ['0.1']);
  client.reply(slow, {}); await rejected; reg.dispose();
});


test('separately imported widget modules share the same client pool', async () => {
  const otherScope = vm.runInNewContext(`${source}\n({ registerJupyterHiGlassDataFetcher })`, {
    TileRequests, window, crypto, AbortController, console,
    hglib: { CSS: '', NOTEBOOK_TILE_PROTOCOL: 1 }, CSSStyleSheet: class { replaceSync() {} },
  });
  const client = model();
  const a = await scope.registerJupyterHiGlassDataFetcher(owner(client));
  const b = await otherScope.registerJupyterHiGlassDataFetcher(owner(client));
  const make = (registration) => new window.higlassDataFetchersByType[registration.name].dataFetcher(hgc, { tilesetUid: 'uid' });
  const fa = make(a); const fb = make(b);
  fa.setVisibleTiles(['0.0']); fb.setVisibleTiles(['0.0']);
  const pa = fa.fetchTilesDebounced(() => {}, ['0.0']);
  const pb = fb.fetchTilesDebounced(() => {}, ['0.0']);
  await delay(0);
  assert.equal(client.sent.length, 1);
  client.reply(client.sent[0], { 'uid.0.0': { dense: [1] } });
  await Promise.all([pa, pb]); a.dispose(); b.dispose();
});
