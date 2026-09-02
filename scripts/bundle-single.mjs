/**
 * Folds the built site into one self-contained HTML file.
 *
 * The app has no runtime assets and no code splitting, so the whole thing is
 * one stylesheet plus one module. Inlining both gives a single file that can be
 * emailed, dropped on a shared drive, or opened straight off a USB stick with
 * no web server at all.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const assets = readdirSync(join(dist, 'assets'));
const js = assets.filter((f) => f.endsWith('.js'));
const css = assets.filter((f) => f.endsWith('.css'));
if (js.length !== 1 || css.length > 1) {
  throw new Error(`expected one js and at most one css chunk, got ${js.length}/${css.length}`);
}

const read = (f) => readFileSync(join(dist, 'assets', f), 'utf8');
// A literal </script> inside a string would close the tag early.
const guard = (s) => s.replace(/<\/script/gi, '<\/script');

let html = readFileSync(join(dist, 'index.html'), 'utf8');
html = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/i, () =>
  css.length ? `<style>\n${read(css[0])}\n</style>` : '');
html = html.replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/i, () =>
  `<script type="module">\n${guard(read(js[0]))}\n</script>`);

const out = join(dist, 'circuit-lab.html');
writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`${out}  ${kb} kB (한 파일, 서버 없이 열림)`);
