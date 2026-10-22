// Renders docs/diagrams/*.excalidraw and *.svg (light and dark) from scenes.mjs using Excalidraw's own
// exporter inside headless Chromium (Playwright is already a dependency). Usage:
//   node scripts/diagrams/render.mjs [--png <dir>]   # --png also writes PNG previews for review
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenes } from './scenes.mjs';

const EXCALIDRAW = 'https://esm.sh/@excalidraw/excalidraw@0.18.0?deps=react@19.1.0,react-dom@19.1.0';
const ASSETS = 'https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'docs', 'diagrams');
const pngDir = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1] : undefined;

await mkdir(outDir, { recursive: true });
if (pngDir) await mkdir(pngDir, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[page]', err.message));
  await page.setContent(`<!doctype html><html><head><script>window.EXCALIDRAW_ASSET_PATH = ${JSON.stringify(ASSETS)};</script></head><body></body></html>`);
  await page.evaluate(async (url) => {
    window.__ex = await import(url);
    // Warm up the hand-drawn font so text is measured (and wrapped) with the metrics it is drawn with.
    const warm = window.__ex.restoreElements([{ type: "text", id: "warm", x: 0, y: 0, text: "warm up", fontSize: 16, fontFamily: 5 }], null);
    await window.__ex.exportToSvg({ elements: warm, appState: { exportEmbedScene: false }, files: null });
    await document.fonts.ready;
  }, EXCALIDRAW);

  for (const scene of scenes) {
    const result = await page.evaluate(
      async ({ skeleton, withPng }) => {
        const ex = window.__ex;
        const elements = ex.restoreElements(ex.convertToExcalidrawElements(skeleton, { regenerateIds: false }), null);
        const base = { exportBackground: true, viewBackgroundColor: '#ffffff', exportPadding: 24, exportEmbedScene: true, exportScale: 1 };
        const light = await ex.exportToSvg({ elements, appState: base, files: null });
        const dark = await ex.exportToSvg({ elements, appState: { ...base, exportWithDarkMode: true }, files: null });
        let png;
        if (withPng) {
          const blob = await ex.exportToBlob({ elements, appState: { ...base, exportEmbedScene: false }, files: null, mimeType: 'image/png', quality: 1 });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
          png = btoa(bin);
        }
        return { elements, light: light.outerHTML, dark: dark.outerHTML, png };
      },
      { skeleton: scene.elements, withPng: Boolean(pngDir) },
    );
    const source = { type: 'excalidraw', version: 2, source: 'https://github.com/AbdelhafzDev/webmorph/blob/main/scripts/diagrams/scenes.mjs', elements: result.elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
    await writeFile(join(outDir, `${scene.name}.excalidraw`), JSON.stringify(source, null, 2) + '\n');
    await writeFile(join(outDir, `${scene.name}.svg`), result.light + '\n');
    await writeFile(join(outDir, `${scene.name}.dark.svg`), result.dark + '\n');
    if (pngDir && result.png) await writeFile(join(pngDir, `${scene.name}.png`), Buffer.from(result.png, 'base64'));
    const fonts = (result.light.match(/@font-face/g) ?? []).length;
    console.log(`${scene.name}: ${result.elements.length} elements, svg ${(result.light.length / 1024).toFixed(0)} KB, ${fonts} embedded font face(s)`);
  }
} finally {
  await browser.close();
}
