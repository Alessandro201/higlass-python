/** Reproduce the original timeout and orphaned batch promises from an unmodified widget.js. */
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/reproduce-baseline.mjs /path/to/original/widget.js');
const source = await fs.readFile(filename, 'utf8');
const messageStart = source.indexOf('function sendCustomMessage(');
const messageEnd = source.indexOf('\n/**', messageStart);
const batchStart = source.indexOf('function consolidator(');
const { sendCustomMessage, consolidator } = vm.runInNewContext(
  `${source.slice(messageStart, messageEnd)}\n${source.slice(batchStart)}\n({ sendCustomMessage, consolidator })`,
  { uid: () => crypto.randomUUID(), AbortSignal, requestAnimationFrame: (fn) => setTimeout(fn, 0) },
);
const listeners = new Set(); const sent = [];
const model = { on: (_, fn) => listeners.add(fn), off: (_, fn) => listeners.delete(fn), send: (msg) => sent.push(msg) };
const started = performance.now();
const keepAlive = setTimeout(() => {}, 3500);
try {
  await assert.rejects(sendCustomMessage(model, { payload: { type: 'tiles' } }), { name: 'TimeoutError' });
} finally {
  clearTimeout(keepAlive);
}
assert.equal(listeners.size, 0);
assert.equal(sent.length, 1);
console.log(JSON.stringify({ defect: 'default_timeout', elapsed_ms: performance.now() - started,
  response_listeners: listeners.size, work_was_sent: true }));
const failures = [];
/** Capture the original unobserved rejection so the reproducer can inspect pending callers. */
const capture = (error) => failures.push(error.message);
process.on('unhandledRejection', capture);
try {
  const batch = consolidator(async () => { throw new Error('injected provider failure'); });
  const requests = [batch('tile-a'), batch('tile-b')];
  const state = await Promise.race([
    Promise.allSettled(requests).then(() => 'settled'), delay(50).then(() => 'pending'),
  ]);
  assert.equal(state, 'pending');
  assert.deepEqual(failures, ['injected provider failure']);
  console.log(JSON.stringify({ defect: 'orphaned_batch_promises', constituent_requests: requests.length,
    state, unhandled_rejections: failures }));
} finally {
  process.off('unhandledRejection', capture);
}
