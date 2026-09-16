/**
 * pw-fetcher.mjs — Playwright-backed page fetcher with Cloudflare bypass
 *
 * Launches a stealth Playwright browser that can pass Cloudflare's bot
 * detection. Used by the proxy when http-proxy-middleware is blocked.
 *
 * Anti-detection measures (via playwright-extra + stealth plugin):
 *   - Uses real Chrome binary (channel: 'chrome') instead of bundled Chromium
 *   - Patches ~15 detection vectors: navigator.webdriver, chrome.runtime,
 *     navigator.plugins, WebGL, iframe contentWindow, etc.
 *   - Disables AutomationControlled blink feature
 *
 * If headless Chrome can't clear a CF challenge (e.g. Turnstile CAPTCHA),
 * a small headed window opens for the user to solve it once. The cookies
 * are then transferred to the headless browser for all future requests.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const CF_PATTERN =
  /checking your browser|just a moment|security verification|please wait|one moment|verify you are human|challenge-platform/i;

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
];

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class PwFetcher {
  constructor() {
    this._browser = null;
    this._context = null;
    this._page = null;
    this._cookies = [];
    // Semaphore-based concurrency limit on rawFetch. Two browsers hitting
    // the proxy in parallel (the user's visible tab + the CLI daemon)
    // fanning out every sub-resource through one apiRequestContext will
    // starve some requests — headers arrive but body streaming stalls,
    // hitting the fetch timeout. Cap in-flight to a browser-realistic 6.
    this._maxConcurrent = 6;
    this._activeCount = 0;
    this._waitQueue = [];
  }

  _acquireSlot() {
    if (this._activeCount < this._maxConcurrent) {
      this._activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._waitQueue.push(resolve));
  }

  _releaseSlot() {
    this._activeCount--;
    const next = this._waitQueue.shift();
    if (next) {
      this._activeCount++;
      next();
    }
  }

  /**
   * Initialize the fetcher. Launches Chrome with anti-detection and
   * navigates to the target URL to prime cookies / clear any CF challenge.
   *
   * @param {string} url - The target site URL
   */
  async init(url) {
    // Try headless first with real Chrome
    let useChrome = true;
    try {
      this._browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: LAUNCH_ARGS,
      });
    } catch {
      // Chrome not installed — fall back to bundled Chromium
      useChrome = false;
      this._browser = await chromium.launch({
        headless: true,
        args: LAUNCH_ARGS,
      });
      console.log(
        "  ⚠ Chrome not found — using Chromium (CF may require manual verification)",
      );
    }

    this._context = await this._browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: REALISTIC_UA,
    });
    this._page = await this._context.newPage();

    // Navigate and wait for CF challenge to clear
    await this._page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const cleared = await this._waitForChallengeToClear(8000);

    if (!cleared) {
      // Headless couldn't clear CF — open a headed window for user to solve
      console.log(
        "  CF requires human verification — opening a browser window...",
      );
      await this._browser.close();

      const headedBrowser = await chromium.launch({
        channel: useChrome ? "chrome" : undefined,
        headless: false,
        args: LAUNCH_ARGS,
      });
      const headedContext = await headedBrowser.newContext({
        viewport: { width: 800, height: 600 },
        userAgent: REALISTIC_UA,
      });
      const headedPage = await headedContext.newPage();
      await headedPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      console.log("  Solve the check in the popup, then it will close automatically.");

      // Wait up to 120s for the user to solve the challenge
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const text = await headedPage.evaluate(() => document.body.innerText);
          if (!CF_PATTERN.test(text)) break;
        } catch {
          break; // page closed or navigated
        }
      }

      // Grab cookies from the headed session
      this._cookies = await headedContext.cookies();
      await headedBrowser.close();

      // Relaunch headless with the clearance cookies
      try {
        this._browser = await chromium.launch({
          channel: useChrome ? "chrome" : undefined,
          headless: true,
          args: LAUNCH_ARGS,
        });
      } catch {
        this._browser = await chromium.launch({
          headless: true,
          args: LAUNCH_ARGS,
        });
      }
      this._context = await this._browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent: REALISTIC_UA,
      });
      await this._context.addCookies(this._cookies);
      this._page = await this._context.newPage();

      // Verify the cookies work
      await this._page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const ok = await this._waitForChallengeToClear(5000);
      if (ok) {
        console.log("  ✔ Verification passed — proxy is ready");
      } else {
        console.warn(
          "  ⚠ CF challenge may not have cleared — proxy may not work",
        );
      }
    } else {
      console.log("  ✔ Cloudflare bypassed automatically");
    }
  }

  /**
   * Fetch a page's raw HTML through the CF-cleared browser context.
   *
   * Navigates the browser (so CF sees a real browser doing a real
   * navigation — Sec-CH-UA-* client hints, Sec-Fetch-* metadata, Turnstile
   * script execution, everything), then returns the RAW response body from
   * the wire via response.text() — not page.content().
   *
   * Why not page.content(): SSR frameworks (TanStack Start's window.$_TSR,
   * Next.js's __NEXT_DATA__, Remix's __remixContext, Nuxt's __NUXT__)
   * inline hydration payloads as script tags in the initial HTML. The
   * client bundle reads them on boot and often removes/clears the script
   * node. By the time page.content() serializes the DOM, the payload is
   * gone and the browser can't rehydrate on the mirror.
   *
   * Why not context.request.get: raw HTTP through the API context skips
   * the browser layer entirely — CF's fingerprinting misses the expected
   * client hints, sec-fetch metadata, and Turnstile refresh, so the
   * session gets challenged even though cookies + UA are shared.
   *
   * @param {string} url - Full URL to fetch
   * @returns {Promise<string>} The raw HTML as served by the origin
   */
  async fetchPage(url) {
    const response = await this._page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // If the navigation landed on a CF challenge (interstitial), wait for
    // it to clear, then fall back to page.content() — after a challenge
    // redirect the initial response object no longer represents the final
    // HTML. This branch is the SSR-hydration-lossy path, unavoidable in
    // full-challenge scenarios.
    try {
      const text = await this._page.evaluate(() => document.body.innerText);
      if (CF_PATTERN.test(text)) {
        console.warn(
          `  ⚠ CF challenge on ${url} — waiting for it to clear...`,
        );
        await this._waitForChallengeToClear(10000);
        return await this._page.content();
      }
    } catch {
      // page navigated — that's fine
    }

    // Happy path: return the untouched network body so hydration payloads
    // survive intact.
    return await response.text();
  }

  /**
   * Raw HTTP through the CF-cleared browser context — reuses cookies,
   * user-agent, and headers so Cloudflare treats it as the same browser
   * session that just passed the challenge. Used by the proxy to serve
   * sub-resources (JS/CSS/fonts/manifest, plus POSTed telemetry/monitoring
   * calls the SPA makes) same-origin from localhost, avoiding the CORS
   * block that a 302 to the real domain triggers.
   *
   * @param {string}  url                - Absolute URL to fetch
   * @param {object}  [opts]
   * @param {string}  [opts.method='GET'] - HTTP method
   * @param {object}  [opts.headers]      - Extra request headers (merged over defaults)
   * @param {Buffer|string} [opts.body]   - Request body for POST/PUT/PATCH
   * @returns {Promise<{status: number, headers: object, body: Buffer}>}
   */
  async rawFetch(url, { method = "GET", headers = {}, body } = {}) {
    await this._acquireSlot();
    try {
      return await this._doRawFetch(url, { method, headers, body });
    } finally {
      this._releaseSlot();
    }
  }

  async _doRawFetch(url, { method, headers, body }, attempt = 1) {
    try {
      const resp = await this._context.request.fetch(url, {
        method,
        headers: {
          "accept": "*/*",
          "accept-language": "en-US,en;q=0.9",
          ...headers,
        },
        data: body,
        timeout: 60000,
      });
      const respBody = await resp.body();
      return {
        status: resp.status(),
        headers: resp.headers(),
        body: respBody,
      };
    } catch (err) {
      // Retry once on transient failure (timeout, ECONNRESET). Some CF
      // edges close idle connections; a fresh request usually succeeds.
      const transient = /timeout|ECONNRESET|ECONNREFUSED|socket hang up/i.test(err.message);
      if (transient && attempt === 1) {
        return this._doRawFetch(url, { method, headers, body }, 2);
      }
      throw err;
    }
  }

  /**
   * Get cookies from the current browser context.
   * Useful for sharing CF clearance with other Playwright instances (e.g. capture).
   */
  async getCookies() {
    if (this._cookies.length) return this._cookies;
    try {
      return await this._context.cookies();
    } catch {
      return [];
    }
  }

  /**
   * Close the browser.
   */
  async close() {
    try {
      await this._browser?.close();
    } catch {}
  }

  /**
   * Poll the current page for CF challenge text to disappear.
   * @param {number} maxMs - Maximum wait time in milliseconds
   * @returns {Promise<boolean>} true if the challenge cleared
   */
  async _waitForChallengeToClear(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      try {
        const text = await this._page.evaluate(() => document.body.innerText);
        if (!CF_PATTERN.test(text)) return true;
      } catch {
        return true; // page navigated away from challenge
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}
