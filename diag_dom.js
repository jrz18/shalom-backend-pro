// DIAGNÓSTICO 4: inspecciona el DOM real del login. ¿Captcha de verdad o cambio de selector?
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
  await delay(2000);

  const dom = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map(i => ({
      id: i.id, name: i.name, type: i.type, placeholder: i.placeholder,
      visible: !!(i.offsetWidth || i.offsetHeight)
    }));
    const buttons = [...document.querySelectorAll('button')].map(b => ({
      cls: b.className, txt: (b.innerText || '').trim().slice(0, 30), type: b.type
    }));
    const iframes = [...document.querySelectorAll('iframe')].map(f => f.src);
    const html = document.documentElement.innerHTML;
    const captchaHits = ['recaptcha', 'hcaptcha', 'turnstile', 'cf-challenge', 'grecaptcha', 'cloudflare']
      .filter(k => html.toLowerCase().includes(k));
    return { inputs, buttons, iframes, captchaHits };
  });
  console.log('[DOM] inputs:', JSON.stringify(dom.inputs, null, 1));
  console.log('[DOM] buttons:', JSON.stringify(dom.buttons));
  console.log('[DOM] iframes:', JSON.stringify(dom.iframes));
  console.log('[DOM] menciones captcha/cloudflare en HTML:', JSON.stringify(dom.captchaHits));

  await delay(6000);
  await browser.close();
})().catch(e => { console.error('[DOM] ERROR', e); process.exit(1); });
