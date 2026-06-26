// DIAGNÓSTICO (no crea envíos). Login headful + sin flag de automatización,
// y prueba 3 caminos para aislar la causa del 401 "No autenticado".
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
require('dotenv').config();

const API_KEY_FIRMA = 'pk_over_5pg91gO6CSgmT627cf2sC8B7dqjxcLFQhW7HhnitKq3';
const BASE = 'https://pro.shalom.pe';

function sign(method, path, ts, nonce, secret) {
  const msg = method.toUpperCase() + path.replace(/^\//, '') + ts + nonce;
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--no-first-run']
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('[DIAG] Abriendo /login (headful, sin flag de automatización)...');
  await page.goto(BASE + '/login', { waitUntil: 'networkidle2' });
  await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER, { delay: 80 });
  await page.type('#passwordLogin', process.env.SHALOM_PASS, { delay: 80 });
  await page.click('button.btn-redshalom');
  await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
  console.log('[DIAG] URL tras login:', page.url());

  // PROBE 1: window.axios GET /get-auth-user (salud de sesión, camino del propio frontend)
  const p1 = await page.evaluate(async () => {
    try { const r = await window.axios.get('/get-auth-user'); return { status: r.status, data: JSON.stringify(r.data).slice(0, 150) }; }
    catch (e) { return { status: e.response && e.response.status, err: e.message, data: e.response ? JSON.stringify(e.response.data).slice(0, 150) : null }; }
  });
  console.log('[DIAG] PROBE 1  in-page axios GET /get-auth-user =>', JSON.stringify(p1));

  // PROBE 2: window.axios POST /envia_ya/terminals (el camino real que necesitamos)
  const p2 = await page.evaluate(async () => {
    try { const r = await window.axios.post('/envia_ya/terminals', {}); return { status: r.status, keys: Object.keys(r.data || {}).slice(0, 6) }; }
    catch (e) { return { status: e.response && e.response.status, err: e.message, data: e.response ? JSON.stringify(e.response.data).slice(0, 150) : null }; }
  });
  console.log('[DIAG] PROBE 2  in-page axios POST /envia_ya/terminals =>', JSON.stringify(p2));

  // Cosechar cookie + secretos para el probe de Node (portabilidad a Cloud Run)
  const cookiesObj = await page.cookies();
  const cookieHeader = cookiesObj.map(c => `${c.name}=${c.value}`).join('; ');
  const xsrf = decodeURIComponent((cookiesObj.find(c => c.name === 'XSRF-TOKEN') || {}).value || '');
  const metas = await page.evaluate(() => ({
    apiSecret: (document.querySelector('meta[name="api-secret"]') || {}).content || null,
    responseKey: (document.querySelector('meta[name="response-key"]') || {}).content || null
  }));
  const ua = await page.evaluate(() => navigator.userAgent);
  console.log('[DIAG] cookies enviashalom_session:', cookiesObj.some(c => c.name === 'enviashalom_session'),
    '| secretos:', { apiSecret: !!metas.apiSecret, responseKey: !!metas.responseKey });

  // PROBE 3: Node fetch con cookie+firma cosechadas (lo que hace el motor hoy)
  const ts = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).substring(2, 10);
  const path = '/get-auth-user';
  const sig = metas.apiSecret ? sign('GET', path, ts, nonce, metas.apiSecret) : '';
  try {
    const resp = await fetch(BASE + path, {
      method: 'GET',
      headers: {
        'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf, 'Cookie': cookieHeader,
        'x-requested-with': 'XMLHttpRequest', 'User-Agent': ua,
        'X-API-KEY': API_KEY_FIRMA, 'X-TIMESTAMP': String(ts), 'X-NONCE': nonce, 'X-SIGNATURE': sig
      }
    });
    const body = await resp.text();
    console.log('[DIAG] PROBE 3  node fetch GET /get-auth-user => status', resp.status, '|', body.slice(0, 150));
  } catch (e) { console.log('[DIAG] PROBE 3 error:', e.message); }

  console.log('\n[DIAG] Listo. Cierro en 15s.');
  await new Promise(r => setTimeout(r, 15000));
  await browser.close();
})().catch(e => { console.error('[DIAG] ERROR', e); process.exit(1); });
