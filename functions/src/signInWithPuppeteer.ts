import { https } from 'firebase-functions/v2';
import { FunctionOutputType } from '../../types/Function';
import { AccessToken, createStoredToken, isTokenResponse, storeEncryptedTokens } from './subsplashUtils';
import { Browser, HTTPResponse, Page } from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import puppeteerExtraPluginStealth from 'puppeteer-extra-plugin-stealth';
import getVerificationCode from './gmailProcessing';
import { installMouseHelper } from '../lib/puppeteer/installMouseHelper';

export type SignInWithPuppeteerOutputType = FunctionOutputType<string>;
const SHOW_BROWSER = false;
interface MouseMovementOptions {
  minDelay?: number;
  maxDelay?: number;
  maxOffset?: number;
  smoothness?: number;
}

/**
 * Simulates natural mouse movement using bezier curves for smooth transitions
 */
async function createNaturalMouseMovement(
  page: Page,
  endX: number,
  endY: number,
  duration = 2000,
  options: MouseMovementOptions = {}
) {
  const { minDelay = 20, maxDelay = 40, maxOffset = 400, smoothness = 50 } = options;

  const startTime = Date.now();
  const endTime = startTime + duration;

  // Start at a random point
  const startX = endX + (Math.random() * 2 - 1) * maxOffset;
  const startY = endY + (Math.random() * 2 - 1) * maxOffset;

  // Generate control points for bezier curve
  const generateControlPoint = () => ({
    x: startX + (Math.random() * 2 - 1) * maxOffset,
    y: startY + (Math.random() * 2 - 1) * maxOffset,
  });

  while (Date.now() < endTime) {
    const controlPoint1 = generateControlPoint();
    const controlPoint2 = generateControlPoint();

    // Calculate points along bezier curve
    for (let t = 0; t <= 1; t += 1 / smoothness) {
      const point = bezierCurve({ x: startX, y: startY }, controlPoint1, controlPoint2, { x: endX, y: endY }, t);

      await page.mouse.move(point.x, point.y);
      await new Promise((resolve) => setTimeout(resolve, minDelay + Math.random() * (maxDelay - minDelay)));
    }
  }
}

/**
 * Calculate point along a cubic bezier curve
 */
function bezierCurve(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const x =
    Math.pow(1 - t, 3) * p0.x +
    3 * Math.pow(1 - t, 2) * t * p1.x +
    3 * (1 - t) * Math.pow(t, 2) * p2.x +
    Math.pow(t, 3) * p3.x;
  const y =
    Math.pow(1 - t, 3) * p0.y +
    3 * Math.pow(1 - t, 2) * t * p1.y +
    3 * (1 - t) * Math.pow(t, 2) * p2.y +
    Math.pow(t, 3) * p3.y;
  return { x, y };
}

interface Point {
  x: number;
  y: number;
}

/**
 * Handles the login process with proper error handling and timeout management
 */
async function handleLogin(
  page: Page,
  email: string,
  password: string,
  checkForToken: () => boolean,
  options = { timeout: 10000 }
): Promise<boolean> {
  try {
    await page.goto('https://dashboard.subsplash.com/auth/login', {
      waitUntil: 'networkidle0',
      timeout: options.timeout,
    });
    if (checkForToken()) {
      return true;
    }
    // Wait for email field with proper timeout
    const emailField = await page.waitForSelector('#email', { timeout: options.timeout });
    if (!emailField) throw new Error('Email field not found');

    // Simulate natural mouse movement
    const { x, y } = (await emailField.boundingBox()) || { x: 0, y: 0 };
    await createNaturalMouseMovement(page, x + 20, y + 10, 1500);

    // Type with variable delays to simulate natural typing
    await page.type('#email', email, {
      delay: 50 + Math.random() * 100,
    });

    await page.type('#password', password, {
      delay: 75 + Math.random() * 100,
    });

    // Add slight pause before pressing Enter

    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 200));
    await page.keyboard.press('Enter');

    return true;
  } catch (error) {
    console.error('Login failed:', error);
    return false;
  }
}
// const goThroughLoginMotions = async (page: Page, email: string, password: string): Promise<void> => {
//   await page.goto('https://dashboard.subsplash.com/auth/login');
//   await page.waitForSelector('#email');

//   await moveMouseAround(page, Math.random() * 100 + 200, Math.random() * 100 + 100, Math.random() * 750 + 1500);
//   await page.type('#email', email, { delay: Math.random() * 100 + 50 });
//   await page.type('#password', password, { delay: Math.random() * 100 + 75 });
//   await page.keyboard.press('Enter');
// };

async function loadCookiesFromEnvVariable(browser: Browser) {
  const base64Cookies = process.env.PUPPETEER_COOKIES;

  if (base64Cookies) {
    const cookiesJson = Buffer.from(base64Cookies, 'base64').toString('utf8');
    const cookies = JSON.parse(cookiesJson);
    await browser.setCookie(...cookies);

    console.log('Cookies loaded from environment variable.');
  } else {
    console.log('No cookies found in environment variable.');
  }
}

async function saveCookiesIntoEnvVariable(browser: Browser) {
  const cookies = await browser.cookies();
  const base64Cookies = Buffer.from(JSON.stringify(cookies)).toString('base64');
  process.env.PUPPETEER_COOKIES = base64Cookies;
}

const signInToSubsplash = async (retries_left = 10): Promise<AccessToken> => {
  console.log('Using Puppeteer to login');
  if (!process.env.EMAIL || !process.env.PASSWORD || !process.env.ENCRYPTION_KEY) {
    throw new Error('Missing email or password or encryption_key  in .env file');
  }
  if (process.env.ENCRYPTION_KEY.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be of length 32, current length is ${process.env.ENCRYPTION_KEY.length}`);
  }
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  const encryption_key = process.env.ENCRYPTION_KEY;
  puppeteerExtra.use(puppeteerExtraPluginStealth());
  const browser = await puppeteerExtra.launch({
    headless: !SHOW_BROWSER,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  await loadCookiesFromEnvVariable(browser);
  const page = await browser.newPage();
  let access_token: string | undefined = undefined;
  const checkForToken = () => {
    return access_token !== undefined;
  };
  page.on('response', async (response: HTTPResponse) => {
    const url = response.url();
    if (url === 'https://core.subsplash.com/accounts/v2/oauth/token') {
      const responseBody = await response.json();
      if (responseBody.access_token) {
        console.log('Access token found early');
        access_token = responseBody.access_token;
        page.off('response');
      }
    }
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 768 });
  if (SHOW_BROWSER) {
    await installMouseHelper(page);
  }
  // Function to capture the response and wait for it
  const waitForResponse = (page: Page, urlToWaitFor: string) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return new Promise<unknown>((resolve, _) => {
      page.on('response', async (response) => {
        const url = response.url();
        if (url === urlToWaitFor) {
          const responseBody = await response.json();
          page.off('response');
          resolve(responseBody); // Resolve the promise with the response
        }
      });
    });
  };

  const filterTime = Math.floor(Date.now() / 1000); // current time in seconds to filter verification emails
  let success = false;
  let response;
  const RETRIES = retries_left;
  while (!success && retries_left > 0) {
    retries_left--;
    if (access_token) {
      await saveCookiesIntoEnvVariable(browser);
      browser.close();
      return access_token;
    }
    await handleLogin(page, email, password, checkForToken);
    if (access_token) {
      await saveCookiesIntoEnvVariable(browser);
      browser.close();
      return access_token;
    }
    response = await waitForResponse(page, 'https://core.subsplash.com/accounts/v2/oauth/token');
    if (typeof response == 'object' && response !== null && !('error' in response)) {
      success = true;
    } else {
      console.log(`Verification failed (retrying up to ${retries_left} more time(s))`);
      console.debug('Response body:', response);
    }
  }
  if (!success) {
    browser.close();
    const message = `Could not get passed recaptcha in ${RETRIES} tries`;
    console.error(message);
    throw new Error(message);
  }

  if (typeof response == 'object' && response !== null && 'mfa_token' in response) {
    await page.waitForNavigation({ waitUntil: 'networkidle0' }); // 'networkidle0' ensures no more than 0 network connections for at least 500 ms
    await page.waitForSelector('#verification-code', { visible: true });
    try {
      console.log('Calling get verificationCode');
      const verificationCode = await getVerificationCode(filterTime);
      await page.type('#verification-code', verificationCode);
    } catch (error) {
      console.error(error);
      throw error;
    }
    await page.keyboard.press('Enter');
  }
  const tokenResponse = await waitForResponse(page, 'https://core.subsplash.com/accounts/v2/oauth/token');
  if (isTokenResponse(tokenResponse)) {
    const tokenToStore = createStoredToken(tokenResponse);
    console.debug(tokenToStore);
    await saveCookiesIntoEnvVariable(browser);
    await browser.close();
    await storeEncryptedTokens(tokenToStore, email, encryption_key);
    return tokenToStore.access_token;
  } else {
    await browser.close();
    throw new Error('Error retrieving access token');
  }
};

const signInWithPuppeteer = https.onCall(
  { memory: '1GiB', timeoutSeconds: 300, maxInstances: 1 },
  async (): Promise<SignInWithPuppeteerOutputType> => {
    // check if user is admin (true "admin" custom claim), return error if not
    try {
      const accessToken = await signInToSubsplash();
      return { status: 'success', data: accessToken };
    } catch (error) {
      return { status: 'error', error: `${error}` };
    }
  }
);

export default signInWithPuppeteer;
