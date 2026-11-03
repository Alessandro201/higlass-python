import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TileRequests, sendCustomMessage } from '../../src/higlass/tile-requests.js';

/** Minimal Jupyter model preserving real listener and response semantics. */
export class Model {
  listeners = new Set();
  sent = [];
  on(_event, fn) { this.listeners.add(fn); }
  off(_event, fn) { this.listeners.delete(fn); }
  send(message) { this.sent.push(message); }
  reply(message, payload = {}) {
    for (const fn of [...this.listeners]) fn({ id: message.id, payload }, []);
  }
}

/** Flush scheduler and promise completion microtasks. */
const tick = () => delay(0);

 test('reads longer than three seconds succeed and remove listeners', async () => {
  const model = new Model();
  const pool = new TileRequests(model);
  const pending = pool.request('slow', { type: 'tiles', tileIds: ['slow'] }, new AbortController().signal);
  await tick();
  await delay(3100);
  assert.equal(model.listeners.size, 1);
  model.reply(model.sent[0], { slow: { dense: [1] } });
  assert.deepEqual((await pending).payload.slow.dense, [1]);
  assert.equal(model.listeners.size, 0);
  assert.equal(pool.active, 0);
  pool.close();
});

test('structured Python errors reject once; late and out-of-order replies are ignored', async () => {
  const model = new Model();
  const signal = new AbortController().signal;
  const first = sendCustomMessage(model, { payload: {}, signal });
  const second = sendCustomMessage(model, { payload: {}, signal });
  const rejected = assert.rejects(first, (error) => error.name === 'OSError' && error.details.request.tileIds[0] === 'x');
  model.reply(model.sent[1], { second: true });
  for (const fn of [...model.listeners]) fn({ id: model.sent[0].id,
    error: { type: 'OSError', message: 'broken read', request: { tileIds: ['x'] } } });
  await rejected;
  assert.equal((await second).payload.second, true);
  model.reply(model.sent[0]);
  assert.equal(model.listeners.size, 0);
});

test('pre-aborted and synchronous send failure do not leak or send stale work', async () => {
  const model = new Model();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sendCustomMessage(model, { payload: {}, signal: controller.signal }));
  assert.equal(model.sent.length, 0);
  model.send = () => { throw new Error('comm closed'); };
  await assert.rejects(sendCustomMessage(model, { payload: {}, signal: new AbortController().signal }));
  assert.equal(model.listeners.size, 0);
});

test('sharing survives one view leaving; last consumer cancellation retains physical capacity', async () => {
  const model = new Model();
  const pool = new TileRequests(model, { concurrency: 1 });
  const a = new AbortController(); const b = new AbortController();
  const first = pool.request('shared', {}, a.signal);
  const second = pool.request('shared', {}, b.signal);
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  await tick();
  a.abort();
  await firstRejected;
  assert.equal(model.sent.length, 1);
  model.reply(model.sent[0], { shared: 1 });
  assert.equal((await second).payload.shared, 1);
  const c = new AbortController();
  const stale = pool.request('stale', {}, c.signal);
  const staleRejected = assert.rejects(stale, { name: 'AbortError' });
  await tick(); c.abort(); await staleRejected;
  const current = pool.request('current', {}, new AbortController().signal);
  await tick();
  assert.equal(model.sent.at(-1).payload.type, 'cancel');
  assert.equal(pool.active, 1);
  model.reply(model.sent[1]);
  await tick();
  assert.equal(model.sent.length, 4);
  model.reply(model.sent[3]);
  await current;
  pool.close();
});

test('rapid resolutions discard obsolete queue and prioritize latest visible work', async () => {
  const model = new Model();
  const pool = new TileRequests(model, { concurrency: 1 });
  const blocked = pool.request('running', {}, new AbortController().signal);
  await tick();
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    const stale = pool.request(`old-${i}`, {}, controller.signal);
    const rejected = assert.rejects(stale, { name: 'AbortError' });
    controller.abort(); await rejected;
  }
  const olderView = pool.request('other-visible-view', {}, new AbortController().signal);
  const latest = pool.request('latest-resolution', {}, new AbortController().signal);
  assert.equal(pool.jobs.size, 3);
  model.reply(model.sent[0]); await blocked; await tick();
  assert.equal(pool.jobs.get('latest-resolution').started, true);
  model.reply(model.sent[1]); await latest; await tick();
  model.reply(model.sent[2]); await olderView;
  assert.equal(model.sent.length, 3);
  pool.close();
});

test('disposal settles active and queued consumers and clears listeners', async () => {
  const model = new Model(); const pool = new TileRequests(model, { concurrency: 1 });
  const active = pool.request('a', {}, new AbortController().signal);
  const queued = pool.request('b', {}, new AbortController().signal);
  const settled = Promise.all([assert.rejects(active), assert.rejects(queued)]);
  await tick(); pool.close(); await settled; await tick();
  assert.equal(model.listeners.size, 0);
  assert.equal(pool.jobs.size, 0);
  assert.equal(pool.active, 0);
});

test('queue capacity is bounded', async () => {
  const model = new Model(); const pool = new TileRequests(model, { capacity: 1 });
  const first = pool.request('first', {}, new AbortController().signal);
  const rejected = assert.rejects(first);
  await assert.rejects(pool.request('overflow', {}, new AbortController().signal), /queue is full/);
  pool.close(); await rejected;
});
