// Bundles the web app into public/ (app.js, app.css). public/index.html and icon.svg are static.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

const common = { bundle: true, minify: !watch, sourcemap: watch ? true : 'external', logLevel: 'info', legalComments: 'none' };
const js = {
  ...common,
  entryPoints: [path.join(root, 'web/src/main.ts')],
  outfile: path.join(root, 'public/app.js'),
  format: 'iife',
  target: ['es2020'],
  define: { __VERSION__: JSON.stringify(pkg.version) },
};
const css = {
  ...common,
  entryPoints: [path.join(root, 'web/style.css')],
  outfile: path.join(root, 'public/app.css'),
  target: ['chrome90', 'firefox90', 'safari15'],
};

if (watch) {
  const a = await esbuild.context(js);
  const b = await esbuild.context(css);
  await Promise.all([a.watch(), b.watch()]);
} else {
  await Promise.all([esbuild.build(js), esbuild.build(css)]);
}
