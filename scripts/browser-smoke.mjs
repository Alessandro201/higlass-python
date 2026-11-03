/** Exercise the bundled widget and real HiGlass/Pixi renderer with deterministic tiles. */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const higlass = path.resolve(process.argv[2] ?? '../higlass');
const { chromium } = await import(pathToFileURL(path.join(higlass, 'node_modules/playwright/index.mjs')));
const bundle = await fs.readFile('src/higlass/widget.bundle.js');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/widget.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/widget.js' ? bundle : '<html><body><div id="widget" style="width:900px;height:550px"></div></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') console.log(msg.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.HIGLASS_TILE_DEBUG = true;
    window.timings = [];
    const debug = console.debug;
    console.debug = (...args) => { window.timings.push(args); debug(...args); };
    const widget = (await import('/widget.js')).default;
    const listeners = new Set(); const messages = new Set();
    const attempts = {}; const sent = [];
    const bytes = new Uint8Array(new Float32Array(256 * 256).fill(1).buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const dense = btoa(binary);
    const tModel = {
      on: (_, fn) => listeners.add(fn), off: (_, fn) => listeners.delete(fn),
      send(msg) {
        sent.push(msg);
        if (msg.payload.type === 'cancel') return;
        const id = msg.payload.tileIds?.[0];
        let payload; let error; let wait = 0;
        if (msg.payload.type === 'tileset_info') {
          payload = { uid: { name: 'deterministic', resolutions: [256, 128, 64],
            min_pos: [0, 0], max_pos: [65536, 65536], max_width: 65536,
            bins_per_dimension: 256, tile_size: 256, max_zoom: 2 } };
        } else {
          attempts[id] = (attempts[id] ?? 0) + 1;
          if (sent.filter((m) => m.payload.type === 'tiles').length === 1) wait = 3100;
          else wait = 30;
          if (window.failNext) {
            window.failNext = false;
            error = { type: 'OSError', message: 'Injected read failure', request: msg.payload };
          } else payload = { [id]: { dense, dtype: 'float32', min_value: 1, max_value: 1 } };
        }
        setTimeout(() => {
          for (const listener of [...listeners]) listener({ id: msg.id, payload, error,
            metrics: { queue_ms: 0, read_ms: wait, response_bytes: JSON.stringify(payload ?? error).length } });
        }, wait);
      },
    };
    const viewconf = { views: [{ uid: 'v', layout: { x: 0, y: 0, w: 12, h: 8 },
      initialXDomain: [0, 65536], initialYDomain: [0, 65536],
      tracks: { top: ['a', 'b'].map((uid) => ({ uid, type: 'horizontal-heatmap',
        height: 180, server: 'jupyter', tilesetUid: 'uid',
        options: { colorRange: ['white', 'red'], showTooltip: false, labelPosition: 'hidden' } })),
        left: [], right: [], center: [], bottom: [] } }] };
    const state = { _viewconf: viewconf, _options: { bounded: true }, _plugin_urls: [],
      _tileset_client: 'IPY_MODEL_client', location: [] };
    const model = { get: (key) => state[key], set: (key, value) => { state[key] = value; },
      save_changes() {}, on: (_, fn) => messages.add(fn), off: (_, fn) => messages.delete(fn),
      widget_manager: { get_model: async () => tModel } };
    window.disposeWidget = await widget.render({ model, el: document.getElementById('widget') });
    window.navigate = (start, end) => {
      for (const fn of messages) fn(JSON.stringify(['zoomTo', 'v', start, end, start, end, 0]));
    };
    window.testState = { attempts, sent, listeners, messages };
  });
  await page.waitForFunction(() => window.timings.filter(([event]) => event === 'higlass.viewport').length >= 2, null, { timeout: 20000 });
  const slow = await page.evaluate(() => window.timings.filter(([event]) => event === 'higlass.tile').map(([, metric]) => metric).some((m) => m.read_ms >= 3100));
  assert.ok(slow, 'slow tile was delivered and rendered');
  await page.evaluate(() => { window.failNext = true; window.timings.length = 0; window.navigate(12000, 20000); });
  await page.waitForFunction(() => window.timings.filter(([event]) => event === 'higlass.viewport').length >= 2, null, { timeout: 20000 });
  const rapidStarted = Date.now();
  for (let i = 0; i < 12; i++) {
    await page.evaluate((i) => window.navigate(2000 * i, 2000 * i + 8000), i);
    await page.waitForTimeout(30);
  }
  await page.evaluate(() => { window.timings.length = 0; window.navigate(40000, 48000); });
  await page.waitForFunction(() => window.timings.filter(([event]) => event === 'higlass.viewport').length >= 2, null, { timeout: 20000 });
  const result = await page.evaluate(() => ({ timings: window.timings, attempts: window.testState.attempts }));
  result.rapid_navigation_wall_ms = Date.now() - rapidStarted;
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/widget.png' });
  await page.evaluate(() => { window.navigate(0, 4000); window.disposeWidget(); });
  await page.waitForTimeout(500);
  const remaining = await page.evaluate(() => ({ comm: window.testState.listeners.size,
    widget: window.testState.messages.size, canvas: document.querySelector('#widget').shadowRoot.querySelectorAll('canvas').length }));
  assert.equal(remaining.comm, 0);
  assert.equal(remaining.widget, 0);
  assert.equal(remaining.canvas, 0);
  assert.deepEqual(errors, []);
  await fs.writeFile('test-results/browser.json', JSON.stringify({ ...result, remaining, errors }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', remaining, viewport: result.timings.filter(([event]) => event === 'higlass.viewport') }));
} finally {
  await browser.close();
  server.close();
}
