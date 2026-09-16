/**
 * capture.mjs — Page context capture
 *
 * Called automatically when `ss connect` runs. Uses Playwright to visit the
 * live site and save context files to ss-context/ in the current project:
 *
 *   ss-context/desktop.png     — full-page screenshot at 1440px
 *   ss-context/tablet.png      — full-page screenshot at 768px
 *   ss-context/mobile.png      — full-page screenshot at 375px
 *   ss-context/page.md         — visual reference + pointer to `ss snapshot`
 *                                for live DOM inspection via @playwright/cli.
 *
 * For DOM structure / selectors, the AI runs `ss snapshot` which spawns a
 * playwright-cli snapshot against the proxy and returns a YAML accessibility
 * tree with `ref` IDs. Screenshots stay here for visual orientation only.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Capture the live page and save context files to ss-context/.
 *
 * @param {string} targetUrl - The live site URL to capture
 * @param {string} testName  - Active test name (included in page.md for AI context)
 * @param {object} [options]
 * @param {Array}  [options.cookies] - Cookies to inject (e.g. CF clearance from PwFetcher)
 */
export async function capturePageContext(targetUrl, testName, { cookies } = {}) {
  const contextDir = join(process.cwd(), 'ss-context');
  mkdirSync(contextDir, { recursive: true });

  console.log(`\n🔍 Capturing page context from ${targetUrl}...`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    // Chromium not downloaded yet — install it automatically on first use
    if (err.message.includes('Executable') || err.message.includes('browserType.launch')) {
      console.log('  Installing Chromium (one-time setup, ~100MB)...');
      try {
        const playwrightBin = join(TOOL_DIR, 'node_modules', '.bin', 'playwright');
        execSync(`"${playwrightBin}" install chromium`, { stdio: 'inherit' });
        browser = await chromium.launch();
      } catch (installErr) {
        console.warn(`  ⚠ Could not install Chromium: ${installErr.message}\n`);
        return;
      }
    } else {
      console.warn(`  ⚠ Could not launch browser: ${err.message}\n`);
      return;
    }
  }

  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet',  width: 768,  height: 1024 },
    { name: 'mobile',  width: 375,  height: 812 },
  ];

  const context = await browser.newContext({
    viewport: { width: viewports[0].width, height: viewports[0].height },
  });

  // Inject CF clearance cookies if provided (for Cloudflare-protected sites)
  if (cookies && cookies.length) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.warn(`  ⚠ Page capture timed out or failed: ${err.message}`);
    console.warn(`    The proxy will still work — context files just weren't saved.\n`);
    await browser.close();
    return;
  }

  // Full-page screenshots at each viewport size
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(300); // let layout settle after resize
    await page.screenshot({
      path: join(contextDir, `${vp.name}.png`),
      fullPage: true,
    });
    console.log(`  ✔ ${vp.name}.png (${vp.width}px)`);
  }

  const pageTitle = await page.title();
  await browser.close();

  const md = [
    `# Page Context: ${pageTitle}`,
    ``,
    `**URL:** ${targetUrl}`,
    `**Active test:** tests/${testName}/`,
    ``,
    `## Screenshots (visual reference)`,
    `- **Desktop (1440px):** ss-context/desktop.png`,
    `- **Tablet (768px):** ss-context/tablet.png`,
    `- **Mobile (375px):** ss-context/mobile.png`,
    ``,
    `## Live DOM (for selectors + interaction)`,
    `Run \`ss snapshot\` to write a YAML accessibility tree with \`ref\` IDs to`,
    `disk. Use those refs with \`ss click <ref>\` / \`ss fill <ref> <text>\` to`,
    `interact with the proxied page (variation applied).`,
    ``,
    `Full CLI surface via \`ss browser <subcommand>\` — passthrough to`,
    `\`playwright-cli\` for anything the wrappers don't cover.`,
    ``,
    `## Workflow`,
    `1. Look at the screenshots for layout / design language.`,
    `2. Run \`ss snapshot\` to get the DOM tree.`,
    `3. Edit \`tests/${testName}/v1/variation.js\` — proxy rebuilds automatically.`,
    `4. Run \`ss snapshot\` again to confirm the change.`,
  ].join('\n');

  writeFileSync(join(contextDir, 'page.md'), md);

  console.log(`✔ Context saved to ss-context/`);
  console.log(`  desktop.png, tablet.png, mobile.png — visual reference`);
  console.log(`  page.md — pointer to ss snapshot for live DOM\n`);
}
