// Copies the HTML and CSS next to the compiled scripts, so the app can load them.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/ui', { recursive: true });
for (const file of ['panel.html', 'library.html', 'styles.css']) {
  cpSync(`src/renderer/${file}`, `dist/ui/${file}`);
}
