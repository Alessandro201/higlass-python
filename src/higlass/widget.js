import * as hglib from "https://esm.sh/higlass@2.2.3?deps=react@17,react-dom@17,pixi.js@6";
import * as ReactDOM from "react-dom";
import { TileRequests } from "./tile-requests.js";

/** @import { AnyModel } from "@anywidget/types" */
/** @import { PluginDataFetcherConstructor, GenomicLocation, Viewconf, DataFetcher} from "./types.ts" */

if (hglib.NOTEBOOK_TILE_PROTOCOL !== 1) {
  throw new Error("This widget requires the patched HiGlass build; see TILE_LOADING.md");
}

const NAME = "jupyter";

let HIGLASS_STYLES = new CSSStyleSheet();
HIGLASS_STYLES.replaceSync(hglib.CSS);

/**
 * @param {string} href
 * @returns {Promise<void>}
 */
function loadScript(href) {
  /** @param {string} href */
  function isScriptLoaded(href) {
    return document.querySelector(`script[src="${href}"]`) !== null;
  }

  return new Promise((resolve, reject) => {
    if (isScriptLoaded(href)) {
      return resolve();
    }
    let script = document.createElement("script");
    script.src = href;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(script);
  });
}

/**
 * Temporarily disables RequireJS to reliably load legacy scripts, then restores it.
 *
 * Clears `window.require`, `window.requirejs`, and `window.define` to prevent
 * interference from RequireJS when loading scripts.
 *
 * @param {Array<string>} pluginUrls - URLs of the scripts to load.
 * @returns {Promise<void>} Resolves when all scripts have been processed.
 */
async function requireScripts(pluginUrls) {
  let backup = {
    // @ts-expect-error - not on the window
    define: window.define,
    require: window.require,
    // @ts-expect-error - not on the window
    requirejs: window.requirejs,
  };
  for (let field of Object.keys(backup)) {
    // @ts-expect-error - not on the window
    window[field] = undefined;
  }

  let results = await Promise.allSettled(pluginUrls.map(loadScript));

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.warn(`Failed to load script: ${pluginUrls[i]}`, result.reason);
    }
  });

  Object.assign(window, backup);
}

/**
 * Create a unique identifier.
 * @returns {string}
 */
function uid() {
  return crypto.randomUUID();
}

/**
 * Make an assertion.
 *
 * @param {unknown} expression - The expression to test.
 * @param {string=} msg - The optional message to display if the assertion fails.
 * @returns {asserts expression}
 * @throws an {@link Error} if `expression` is not truthy.
 */
function assert(expression, msg = "") {
  if (!expression) throw new Error(msg);
}

/**
 * Transforms the original view config into tracks recognized by the custom data fetcher.
 *
 * Finds tracks with `server: 'jupyter'`, removes the key, and adds a `data` object
 * with `type: dataFetcherId` and the track’s `tilesetUid`.
 *
 * @param {Viewconf} viewConfig - The original view configuration.
 * @returns {Viewconf} A modified deep copy of the view config.
 *
 * @example
 * ```js
 * resolveJupyterServers(
 *   { views: [{ tracks: { top: [{ server: 'jupyter', tilesetUid: 'abc' }] } }] },
 *   'jupyter-123'
 * );
 * // Returns:
 * // {
 * //   views: [{ tracks: { top: [{ tilesetUid: 'abc', data: { type: 'jupyter', tilesetUid: 'abc' } }] } }]
 * // }
 * ```
 */
function resolveJupyterServers(viewConfig, dataFetcherId) {
  const copy = JSON.parse(JSON.stringify(viewConfig));

  for (const view of copy.views) {
    const baseTracks = Object.values(view.tracks).flat();
    let allTracks = Object.values(view.tracks).flat();

    for (const track of baseTracks) {
      // Go through and check for combined tracks
      if (track.contents) {
        allTracks = allTracks.concat(allTracks, track.contents);
      }
    }

    for (const track of allTracks) {
      if (track?.server === NAME) {
        delete track.server;
        track.data = track.data || {};
        track.data.type = dataFetcherId;
        track.data.tilesetUid = track.tilesetUid;
      }
    }
  }
  return copy;
}

// A tileset client can be shared by several widgets in the same notebook.
const clients = window[Symbol.for("higlass.notebook.tile-clients.v1")] ??= new WeakMap();

/** Register a fetcher scoped to this rendered widget and its tileset client. */
async function registerJupyterHiGlassDataFetcher(model) {
  let tModel = await model.widget_manager.get_model(
    model.get("_tileset_client").slice("IPY_MODEL_".length),
  );
  let pool = clients.get(tModel);
  if (!pool) {
    pool = new TileRequests(tModel);
    pool.users = 0;
    clients.set(tModel, pool);
  }
  pool.users++;
  let name = `${NAME}-${uid()}`;
  let fetchers = new Set();

  /** Connect HiGlass's per-track visibility to shared notebook requests. */
  function DataFetcher(hgc, dataConfig, pubSub) {
    let lifetime = new AbortController();
    let pending = new Map();
    let visible = new Set();
    let fetcher = new hgc.dataFetchers.DataFetcher(
      { ...dataConfig, server: NAME }, pubSub, {
        async fetchTilesetInfo({ server, tilesetUid }) {
          assert(server === NAME, "must be a jupyter server");
          let response = await pool.request(`info:${tilesetUid}`, {
            type: "tileset_info", tilesetUid,
          }, lifetime.signal);
          return response.payload;
        },
        fetchTiles() { throw new Error("Use the notebook tile scheduler"); },
        registerTileset() { throw new Error("Not implemented"); },
      },
    );
    // HiGlass calls this even when all currently visible tiles are already fetching.
    fetcher.setVisibleTiles = (ids) => {
      visible = new Set(ids);
      for (let [id, controller] of pending) {
        if (!visible.has(id)) controller.abort();
      }
    };
    fetcher.fetchTilesDebounced = async (receivedTiles, ids) => {
      let results = await Promise.allSettled(ids.map(async (id) => {
        let controller = new AbortController();
        pending.set(id, controller);
        let fullId = `${dataConfig.tilesetUid}.${id}`;
        try {
          if (lifetime.signal.aborted || !visible.has(id)) controller.abort();
          let response = await pool.request(fullId, {
            type: "tiles", tileIds: [fullId],
          }, controller.signal);
          if (!visible.has(id) || lifetime.signal.aborted) return;
          if (!response.payload?.[fullId]) {
            throw new Error(`Tile ${fullId}: missing response`);
          }
          let data = hgc.services.tileResponseToData(response.payload, NAME, [fullId]);
          if (!data[fullId] || data[fullId].error) {
            throw new Error(`Tile ${fullId}: ${data[fullId]?.error ?? "missing response"}`);
          }
          data[fullId].tilePositionId = id;
          // Deliver each tile immediately; a slow sibling must not hold it back.
          receivedTiles({ [id]: data[fullId] });
        } catch (error) {
          if (error.name !== "AbortError" && visible.has(id) && !lifetime.signal.aborted) {
            receivedTiles({ [id]: { error, tilePositionId: id } });
          }
          throw error;
        } finally {
          if (pending.get(id) === controller) pending.delete(id);
        }
      }));
      let failure = results.find((result) => result.status === "rejected" &&
        result.reason?.name !== "AbortError");
      if (failure) throw failure.reason;
    };
    fetcher.dispose = () => {
      lifetime.abort();
      for (let controller of pending.values()) controller.abort();
      pending.clear();
      fetchers.delete(fetcher);
    };
    fetchers.add(fetcher);
    return fetcher;
  }

  window.higlassDataFetchersByType ??= {};
  window.higlassDataFetchersByType[name] = { name, dataFetcher: DataFetcher };
  return {
    name,
    dispose() {
      for (let fetcher of fetchers) fetcher.dispose();
      delete window.higlassDataFetchersByType[name];
      if (--pool.users === 0) {
        pool.close();
        clients.delete(tModel);
      }
    },
  };
}

/**
 * @param {GenomicLocation} location
 * @returns {[number, number, number, number]}
 */
function locationToCoordinates({ xDomain, yDomain }) {
  let [x, xe] = xDomain;
  let [y, ye] = yDomain;
  return [x, xe, y, ye];
}

/**
 * @param {HTMLElement} el
 * @returns {() => void} unlisten
 */
function addEventListenersTo(el) {
  let controller = new AbortController();

  // prevent right click events from bubbling up to Jupyter/JupyterLab
  el.addEventListener("contextmenu", (event) => event.stopPropagation(), {
    signal: controller.signal,
  });

  // prevent wheel events from scrolling the page while allowing HiGlass zoom
  el.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, {
    signal: controller.signal,
    passive: false,
  });

  return () => controller.abort();
}

/**
 * @typedef State
 * @property {Viewconf} _viewconf
 * @property {Record<string, unknown>} _options
 * @property {`IPY_MODEL_${string}`} _tileset_client
 * @property {Array<number> | Array<Array<number>>} location
 * @property {Array<string>} _plugin_urls
 */

export default {
  /** @type {import("@anywidget/types").Render<State>} */
  async render({ model, el }) {
    await requireScripts(model.get("_plugin_urls"));
    let registration = await registerJupyterHiGlassDataFetcher(model);
    let viewconf = resolveJupyterServers(
      model.get("_viewconf"), registration.name,
    );
    let options = model.get("_options") ?? {};

    let shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    shadow.innerHTML = "";
    shadow.adoptedStyleSheets = [HIGLASS_STYLES];
    let container = document.createElement("div");
    shadow.appendChild(container);

    let api;
    try {
      api = await hglib.viewer(container, viewconf, options);
    } catch (error) {
      registration.dispose();
      throw error;
    }
    let unlisten = addEventListenersTo(el);

    const onMessage = (msg) => {
      msg = JSON.parse(msg);
      let [fn, ...args] = msg;
      /** @type {any} */ (api)[fn](...args);
    };
    model.on("msg:custom", onMessage);

    if (viewconf.views.length === 1) {
      api.on(
        "location",
        (/** @type {GenomicLocation} */ loc) => {
          model.set("location", locationToCoordinates(loc));
          model.save_changes();
        },
        viewconf.views[0].uid,
        undefined,
      );
    } else {
      viewconf.views.forEach((view, idx) => {
        api.on(
          "location",
          (/** @type{GenomicLocation} */ loc) => {
            let location = model.get("location").slice();
            location[idx] = locationToCoordinates(loc);
            model.set("location", location);
            model.save_changes();
          },
          view.uid,
          undefined,
        );
      });
    }

    return () => {
      unlisten();
      model.off("msg:custom", onMessage);
      registration.dispose();
      ReactDOM.unmountComponentAtNode(container);
      api.destroy();
    };
  },
};
