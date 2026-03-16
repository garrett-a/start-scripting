/**
 * scaffold.mjs — Creates a new test folder from the _template
 */

import { cpSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// TOOL_DIR: where the ss tool is installed — used to find the _template folder
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Write (or overwrite) the hidden esbuild entry file for a test + variation.
 * Lives in .ss-cache/<testName>.js — outside the test folder so users never see it.
 *
 * @param {string} testName  - e.g. "homepage-hero"
 * @param {string} variation - e.g. "v1"
 */
export function writeCacheEntry(testName, variation) {
  const cacheDir = join(process.cwd(), '.ss-cache');
  mkdirSync(cacheDir, { recursive: true });

  const variationDir = join(process.cwd(), 'tests', testName, variation);
  let imports;

  if (existsSync(variationDir)) {
    const files = readdirSync(variationDir);
    const cssFiles = files.filter((f) => f.endsWith('.css')).sort();
    const jsFiles = files.filter((f) => f.endsWith('.js')).sort();
    imports = [
      ...cssFiles.map((f) => `import '../tests/${testName}/${variation}/${f}';`),
      ...jsFiles.map((f) => `import '../tests/${testName}/${variation}/${f}';`),
    ].join('\n');
  } else {
    // Fallback before directory exists (scaffold copies files after this)
    imports = `import '../tests/${testName}/${variation}/index.css';\nimport '../tests/${testName}/${variation}/variation.js';`;
  }

  writeFileSync(join(cacheDir, `${testName}.js`), imports + '\n');
}

/**
 * Copy the _template folder to tests/<testName>/ in the current working directory.
 *
 * @param {string} testName - Folder name for the new test (e.g. "homepage-hero")
 */
export function scaffoldTest(testName) {
  // Template always comes from the tool's install, not the current project
  const templateDir = join(TOOL_DIR, 'tests', '_template');
  // Test is created in the current project (wherever the user ran ss from)
  const testDir = join(process.cwd(), 'tests', testName);

  if (existsSync(testDir)) {
    console.error(`✖ tests/${testName}/ already exists.`);
    process.exit(1);
  }

  cpSync(templateDir, testDir, { recursive: true });
  writeCacheEntry(testName, 'v1');

  console.log(`✔ Created tests/${testName}/`);
  console.log(`\n  Edit tests/${testName}/v1/variation.js to write your test code.`);
}
