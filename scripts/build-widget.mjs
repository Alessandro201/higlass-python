/** Bundle the patched local HiGlass build and all runtime dependencies into the widget. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const higlass = path.resolve(process.argv[2] ?? '../higlass');
const { build } = await import(pathToFileURL(path.join(higlass, 'node_modules/esbuild/lib/main.js')));
const library = path.join(higlass, 'dist/higlass.mjs');
if (!(await fs.readFile(library, 'utf8')).includes('NOTEBOOK_TILE_PROTOCOL')) {
  throw new Error('Build the patched HiGlass checkout first. An unchanged CDN build is not supported.');
}
await build({
  entryPoints: ['src/higlass/widget.js'],
  outfile: 'src/higlass/widget.bundle.js',
  bundle: true,
  nodePaths: [path.join(higlass, 'node_modules')],
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'local-higlass',
    setup(build) {
      build.onResolve({ filter: /^https:\/\/esm\.sh\/higlass@/ }, () => ({ path: library }));
    },
  }],
});
console.log('Built src/higlass/widget.bundle.js with the patched local HiGlass library.');
