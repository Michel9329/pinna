/**
 * Pinna - build.
 * Builds the Vue app (app/dist) and copies the widget and the demo site into
 * app/dist, so the Worker serves them as static assets next to the SPA.
 *
 *   app/dist/pinna.js    review widget
 *   app/dist/demo.html   demo site to try the flow
 */
import { execSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');

console.log('[pinna] building the Vue app...');
execSync('bun run build', { cwd: app, stdio: 'inherit' });

console.log('[pinna] minifying the widget and copying the demo site into app/dist...');
// The widget is injected on EVERY client page (proxied third-party pages
// included), so it is minified: a smaller download and less parse time.
// esbuild is already there (transitive dependency of vite, in app/).
execSync(
  `npx esbuild "${join(root, 'widget', 'pinna.js')}" --minify --legal-comments=none --outfile="${join(app, 'dist', 'pinna.js')}"`,
  { cwd: app, stdio: 'inherit' },
);
copyFileSync(
  join(root, 'widget', 'demo.html'),
  join(app, 'dist', 'demo.html'),
);

// Note: the comment screenshot is not rasterized in the browser. The widget
// serializes the DOM and the server (Browser Rendering) takes the real
// screenshot, so there is no extra bundle.

console.log('[pinna] build complete.');
