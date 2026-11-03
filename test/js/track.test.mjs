import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const sourceRoot = process.env.HIGLASS_SOURCE ?? path.resolve('../higlass');

/** Execute production track methods with only the graphical dependencies stubbed. */
async function loadClass(file, name, globals = {}) {
  const source = (await readFile(path.join(sourceRoot, file), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export default class/g, 'class')
    .replace(/export function/g, 'function').replace(/^export default \w+;$/gm, '');
  return vm.runInNewContext(`${source}\n${name}`, {
    PixiTrack: class { remove() {} }, performance, setTimeout, clearTimeout,
    queueMicrotask, console, cancelAnimationFrame: clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
    slugid: { nice: () => crypto.randomUUID() }, dictValues: Object.values, ...globals,
  });
}
const Track = await loadClass('app/scripts/TiledPixiTrack.js', 'TiledPixiTrack');
const Fetcher = await loadClass('app/scripts/data-fetchers/DataFetcher.js', 'DataFetcher');

/** Make a track with production request logic and deterministic non-graphical drawing. */
function track(fetch) {
  const t = Object.create(Track.prototype);
  Object.assign(t, { tilesetInfo: {}, visibleTiles: [], visibleTileIds: new Set(),
    fetching: new Set(), fetchedTiles: {}, renderingTiles: new Set(),
    _tileRequests: new Map(), _tileFailures: new Map(), _tileRetainedAt: new Map(), _viewportKey: '',
    _removed: false, _retryTimer: null, _viewportStarted: 0,
    dataFetcher: { fetchTilesDebounced: fetch }, target: ['0.0.0'],
    calculateVisibleTiles() {
      this.visibleTiles = this.target.map((id) => ({ tileId: id, remoteId: id }));
      this.visibleTileIds = new Set(this.target);
    },
    removeOldTiles() {}, _checkForErrors() {}, draw() {}, drawLabel() {},
    synchronizeTilesAndGraphics() {}, animate() {},
  });
  return t;
}

test('rejected and missing responses release fetching and retry', async () => {
  for (const failure of ['reject', 'missing', 'error-tile', 'throw']) {
    let calls = 0;
    const t = track((receive, ids) => {
      calls++;
      if (calls === 1) {
        if (failure === 'throw') throw new Error('sync');
        if (failure === 'reject') return Promise.reject(new Error('read failed'));
        receive(failure === 'missing' ? {} : { [ids[0]]: { error: 'bad tile' } });
        return Promise.resolve({});
      }
      receive({ [ids[0]]: { tilePositionId: ids[0], dense: [1] } });
      return Promise.resolve({});
    });
    try {
      t.refreshTiles(); await delay(20);
      assert.equal(t.fetching.size, 0, failure);
      await delay(280);
      assert.equal(calls, 2, failure);
      assert.equal(Object.keys(t.fetchedTiles).length, 1, failure);
    } finally { t.remove(); }
  }
});

test('out-of-order response cannot clear a newer request after navigation back', async () => {
  const requests = [];
  const t = track((receive, ids) => new Promise((resolve, reject) => requests.push({ receive, ids, resolve, reject })));
  try {
    t.refreshTiles();
    t.target = ['1.2.2']; t.refreshTiles();
    t.target = ['0.0.0']; t.refreshTiles();
    requests[0].receive({ '0.0.0': { tilePositionId: '0.0.0', dense: [99] } });
    requests[0].reject(new Error('stale failure')); await delay(0);
    assert.equal(t.fetching.has('0.0.0'), true);
    assert.equal(t.fetchedTiles['0.0.0'], undefined);
    requests[2].receive({ '0.0.0': { tilePositionId: '0.0.0', dense: [1] } });
    requests[2].resolve(); requests[1].resolve(); await delay(0);
    assert.equal(t.fetching.size, 0);
    assert.equal(t.fetchedTiles['0.0.0'].tileData.dense[0], 1);
  } finally { t.remove(); }
});

test('automatic retries are bounded and navigation back retries a failed tile', async () => {
  let calls = 0;
  const t = track(() => { calls++; return Promise.reject(new Error('bad')); });
  try {
    t.refreshTiles(); await delay(800);
    assert.equal(calls, 3);
    assert.equal(t.fetching.size, 0);
    t.target = ['1.1.1']; t.refreshTiles(); await delay(0);
    t.target = ['0.0.0']; t.refreshTiles(); await delay(0);
    assert.equal(calls, 5);
  } finally { t.remove(); }
});

test('disposal ignores late callbacks and stops retry timers', async () => {
  let receive; let resolve;
  const t = track((cb) => new Promise((done) => { receive = cb; resolve = done; }));
  t.refreshTiles(); t.remove();
  receive({ '0.0.0': { tilePositionId: '0.0.0' } }); resolve(); await delay(300);
  assert.equal(t.fetching.size, 0);
  assert.equal(Object.keys(t.fetchedTiles).length, 0);
});

test('partial DataFetcher response delivers valid tiles without dereferencing missing ones', async () => {
  const f = Object.create(Fetcher.prototype);
  f.dataConfig = { server: 'jupyter', tilesetUid: 'uid' };
  f._tileSource = { fetchTiles: async () => ({ 'uid.0.0.0': { tilesetUid: 'uid' } }) };
  let result;
  await f.fetchTilesDebounced((tiles) => { result = tiles; }, ['0.0.0', '0.1.1']);
  assert.deepEqual(Object.keys(result), ['0.0.0']);
});

test('coarse graphics survive refinement but expire when replacement permanently fails', () => {
  const t = track(() => Promise.resolve({}));
  const destroyed = [];
  t.fetchedTiles = { old: {} }; t.tileGraphics = {}; t.pMain = { removeChild() {} };
  t.destroyTile = () => destroyed.push('old'); t.areAllVisibleTilesLoaded = () => false;
  t._viewportStarted = performance.now();
  t.removeTiles(['old']); assert.equal(destroyed.length, 0);
  t._tileRetainedAt.set('old', performance.now() - 6000);
  t.removeTiles(['old']); assert.equal(destroyed.length, 1);
  t.remove();
});


test('a streamed error retries before a slow sibling finishes', async () => {
  let calls = 0;
  let completeSlow;
  const t = track((receive, ids) => {
    calls++;
    if (calls === 1) {
      queueMicrotask(() => receive({ '0.0.0': { error: new Error('failed') } }));
      return new Promise((resolve) => { completeSlow = resolve; });
    }
    receive({ '0.0.0': { tilePositionId: '0.0.0', dense: [1] } });
    return Promise.resolve();
  });
  t.target = ['0.0.0', '0.1.1'];
  try {
    t.refreshTiles(); await delay(300);
    assert.equal(calls, 2);
    assert.equal(t.fetching.has('0.1.1'), true);
    assert.ok(t.fetchedTiles['0.0.0']);
  } finally { t.remove(); completeSlow(); }
});
