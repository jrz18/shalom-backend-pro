// DIAGNÓSTICO 2 (no crea envíos). Corre la cadena operativa real por window.axios
// en una sesión headful abierta: products, person/search, tariff/calculate.
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
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('[DIAG2] Login...');
  await page.goto(BASE + '/login', { waitUntil: 'networkidle2' });
  await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER, { delay: 80 });
  await page.type('#passwordLogin', process.env.SHALOM_PASS, { delay: 80 });
  await page.click('button.btn-redshalom');
  await delay(5000);
  // Ir a /home para asegurar contexto logueado
  await page.goto(BASE + '/home', { waitUntil: 'networkidle2' }).catch(() => {});
  console.log('[DIAG2] URL:', page.url());

  // Helper: POST por window.axios in-page; devuelve {status, data} ya descifrado por el interceptor de Shalom
  async function apost(path, body) {
    return page.evaluate(async (p, b) => {
      try { const r = await window.axios.post(p, b); return { status: r.status, data: r.data }; }
      catch (e) { return { status: e.response && e.response.status, err: e.message, data: e.response ? e.response.data : null }; }
    }, path, body);
  }

  // 1) products (¿auth real para operar?)
  const prod = await apost('/envia_ya/products', {});
  const prodList = prod.data && prod.data.data;
  console.log('[DIAG2] products => status', prod.status, '| n =', Array.isArray(prodList) ? prodList.length : 'NO-LIST',
    '| titulos:', Array.isArray(prodList) ? prodList.map(p => p.title).slice(0, 8) : prod.data);

  // 2) person/search con un DNI real (solo lectura). ¿Descifra el interceptor?
  const ps = await apost('/envia_ya/person/search', { documento: '05071045', type: 'receiver' });
  console.log('[DIAG2] person/search 05071045 => status', ps.status, '| data:', JSON.stringify(ps.data).slice(0, 220));

  // 3) tariff/calculate Los Pinos(411) -> Cusco/San Jeronimo(203). Solo lectura.
  const tar = await apost('/envia_ya/tariff/calculate', { origin: 411, destiny: '203', width: '', height: '', length: '', weight: '' });
  const tdata = tar.data && tar.data.data;
  console.log('[DIAG2] tariff 411->203 => status', tar.status, '| success:', tar.data && tar.data.success,
    '| tariff keys:', tdata && tdata.tariff ? Object.keys(tdata.tariff) : tdata);

  console.log('\n[DIAG2] Listo. Cierro en 12s.');
  await delay(12000);
  await browser.close();
})().catch(e => { console.error('[DIAG2] ERROR', e); process.exit(1); });
