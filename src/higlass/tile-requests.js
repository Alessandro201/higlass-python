/** @import { AnyModel } from "@anywidget/types" */
/**
 * Send a custom message to Python and _await_ a response.
 *
 * Unlike typical "fire-and-forget" messages, this function returns a `Promise`
 * that resolves when a response is received back from Python.
 *
 * A message is sent with a unique `id` and a payload. The Python handler should:
 *
 * 1. Process the message.
 * 2. Respond with the same `id` and a new payload.
 *
 * An `AbortSignal` can reject the promise. Aborting does not interrupt Python work.
 *
 * **Example:**
 *
 * ```js
 * let response = await sendCustomMessage(model, { payload: "hello" });
 * console.log(response.payload); // HELLO
 * ```
 *
 * **Python handler:**
 *
 * ```py
 * widget = Widget()
 * widget.on_msg(lambda msg, buffers: widget.send({
 *     "id": msg["id"], "payload": msg["payload"].upper()
 * }))
 * ```
 *
 * @template T
 * @param {AnyModel} model
 * @param {{ payload: unknown, signal?: AbortSignal, id?: string }} options
 * @return {Promise<{ payload: T, buffers: Array<DataView> }>}
 */
export function sendCustomMessage(model, { payload, signal, id = crypto.randomUUID() }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    /** Remove both listeners on every terminal path. */
    function cleanup() {
      model.off("msg:custom", handler);
      signal?.removeEventListener("abort", abort);
    }
    /** Reject locally; callers own the separate Python cancellation protocol. */
    function abort() {
      cleanup();
      reject(signal.reason);
    }
    /** Match replies and retain the backend diagnostic context on errors. */
    function handler(msg, buffers) {
      if (msg.id !== id) return;
      cleanup();
      if (msg.error) {
        let error = new Error(msg.error.message);
        error.name = msg.error.type;
        error.requestId = id;
        error.details = msg.error;
        error.metrics = msg.metrics;
        reject(error);
      } else {
        resolve({ payload: msg.payload, buffers, metrics: msg.metrics });
      }
    }
    model.on("msg:custom", handler);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      model.send({ id, payload });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export class TileRequests {
  /** Share tile reads, cap physical requests, and keep queued work newest first. */
  constructor(model, { concurrency = 2, capacity = 256 } = {}) {
    this.model = model;
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.jobs = new Map();
    this.active = 0;
    this.clock = 0;
    this.lifetime = new AbortController();
    this.metrics = [];
  }

  /** Attach an independently cancellable consumer to a tile or metadata request. */
  request(key, payload, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.lifetime.signal.aborted) return Promise.reject(this.lifetime.signal.reason);
    let job = this.jobs.get(key);
    if (!job || job.cancelled) {
      if (this.jobs.size >= this.capacity) {
        return Promise.reject(new Error("Notebook tile queue is full"));
      }
      job = { key, payload, id: crypto.randomUUID(), consumers: new Set(),
        started: false, cancelled: false, queued: performance.now() };
      this.jobs.set(key, job);
    }
    job.priority = ++this.clock;
    return new Promise((resolve, reject) => {
      let consumer = { resolve, reject, signal, abort: null };
      consumer.abort = () => {
        job.consumers.delete(consumer);
        signal.removeEventListener("abort", consumer.abort);
        reject(signal.reason);
        if (job.consumers.size === 0) {
          job.cancelled = true;
          if (this.jobs.get(key) === job) this.jobs.delete(key);
          if (job.started) {
            try { this.model.send({ id: job.id, payload: { type: "cancel" } }); }
            catch { /* A closed comm cannot acknowledge cancellation. */ }
          }
        }
      };
      job.consumers.add(consumer);
      signal.addEventListener("abort", consumer.abort, { once: true });
      // Allow other tracks in this turn to join the same physical request.
      queueMicrotask(() => this.drain());
    });
  }

  /** Start bounded single-tile batches, prioritizing recently requested visible work. */
  drain() {
    if (this.lifetime.signal.aborted) return;
    while (this.active < this.concurrency) {
      let job = [...this.jobs.values()].filter((item) => !item.started)
        .sort((a, b) => b.priority - a.priority)[0];
      if (!job) return;
      job.started = true;
      this.active++;
      let started = performance.now();
      sendCustomMessage(this.model, {
        id: job.id, payload: job.payload, signal: this.lifetime.signal,
      }).then(
        (response) => this.finish(job, null, response, started),
        (error) => this.finish(job, error, null, started),
      );
    }
  }

  /** Release a physical slot only after Python replies, even if consumers left. */
  finish(job, error, response, started) {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    this.active--;
    let metric = { request_id: job.id, key: job.key,
      frontend_queue_ms: started - job.queued,
      roundtrip_ms: performance.now() - started,
      ...(response?.metrics ?? error?.metrics), error: error?.message };
    this.metrics.push(metric);
    if (this.metrics.length > 256) this.metrics.shift();
    if (globalThis.HIGLASS_TILE_DEBUG) console.debug("higlass.tile", metric);
    for (let consumer of job.consumers) {
      consumer.signal.removeEventListener("abort", consumer.abort);
      if (error) consumer.reject(error);
      else consumer.resolve(response);
    }
    job.consumers.clear();
    this.drain();
  }

  /** Settle all consumers and detach comm listeners when the last widget leaves. */
  close() {
    for (let job of this.jobs.values()) {
      if (job.started) {
        try { this.model.send({ id: job.id, payload: { type: "cancel" } }); }
        catch { /* Continue settling consumers after the comm has closed. */ }
      }
      for (let consumer of job.consumers) {
        consumer.signal.removeEventListener("abort", consumer.abort);
        consumer.reject(new DOMException("Widget disposed", "AbortError"));
      }
      job.consumers.clear();
    }
    this.jobs.clear();
    this.lifetime.abort();
  }
}
