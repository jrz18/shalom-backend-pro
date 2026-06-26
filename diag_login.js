// DIAGNÓSTICO 3: ¿el login automatizado autentica? Replica el flujo del motor y
// captura el estado real post-login (URL, error visible, captcha, get-auth-user).
const puppeteer = require('puppeteer-core');
require('dotenv').config();
const BASE = 'https://pro.shalom.pe';
const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--no-first-run']
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

  await page.goto(BASE + '/login', { waitUntil: 'networkidle2' });
  await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER, { delay: 60 });
  await page.type('#passwordLogin', process.env.SHALOM_PASS, { delay: 60 });
  console.log('[LOGIN] credenciales escritas, usuario =', process.env.SHALOM_USER);
  await page.click('button.btn-redshalom');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => console.log('[LOGIN] sin navegacion en 20s'));
  await delay(2000);

  const url = page.url();
  console.log('[LOGIN] URL final:', url);

  const info = await page.evaluate(async () => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
    const hasCaptcha = !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, iframe[src*="hcaptcha"], [class*="captcha"]');
    let auth = null;
    try { const r = await window.axios.get('/get-auth-user'); auth = { status: r.status, ok: !!(r.data && r.data.success) }; }
    catch (e) { auth = { status: e.response && e.response.status, msg: (e.response && e.response.data && e.response.data.message) || e.message }; }
    return { txt, hasCaptcha, auth, hasSecret: !!document.querySelector('meta[name="api-secret"]') };
  });
  console.log('[LOGIN] get-auth-user:', JSON.stringify(info.auth));
  console.log('[LOGIN] captcha presente:', info.hasCaptcha, '| meta api-secret:', info.hasSecret);
  console.log('[LOGIN] texto visible:', info.txt);

  await page.screenshot({ path: 'login_state.png', fullPage: false }).catch(() => {});
  console.log('[LOGIN] screenshot -> login_state.png. Cierro en 10s.');
  await delay(10000);
  await browser.close();
})().catch(e => { console.error('[LOGIN] ERROR', e); process.exit(1); });
