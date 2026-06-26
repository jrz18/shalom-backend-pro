// Mantiene una sesion real de Shalom logueada en Chrome (puerto 9222) y la re-sincroniza a
// Supabase periodicamente, para que el backend en la nube (motor HTTP) pueda usarla sin navegador.
const puppeteer = require('puppeteer-core');
require('dotenv').config();
const { ShalomCDP } = require('./shalom_cdp_api_engine');

const SYNC_EVERY_MS = Number(process.env.SHALOM_SYNC_MS || 10 * 60 * 1000); // 10 min por defecto

async function syncLoop(page) {
    const api = new ShalomCDP();
    api.page = page; // reutilizamos la pagina ya logueada
    const doSync = async () => {
        try { await api.refreshMetadata(); }
        catch (e) { console.log('Aviso: fallo el re-sync:', e.message); }
    };
    await doSync();
    console.log(`LISTO: sesion sincronizada. Re-sync cada ${Math.round(SYNC_EVERY_MS / 60000)} min. Deja esta ventana abierta.`);
    setInterval(doSync, SYNC_EVERY_MS);
}

async function prepareLogin() {
    try {
        console.log("Iniciando Chrome...");
        const browser = await puppeteer.launch({
            executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: false,
            userDataDir: require('path').join(require('os').tmpdir(), 'chrome-shalom-bot'),
            defaultViewport: null,
            args: ['--remote-debugging-port=9222', '--start-maximized']
        });
        const page = (await browser.pages())[0];
        await page.goto('https://pro.shalom.pe/home', { waitUntil: 'networkidle2' });

        if (page.url().includes('/home')) {
            console.log("Sesion detectada.");
            return syncLoop(page);
        }

        // No logueado: pre-llenar credenciales y esperar a que el usuario entre.
        await page.goto('https://pro.shalom.pe/login', { waitUntil: 'networkidle2' });
        await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER || '');
        await page.type('#passwordLogin', process.env.SHALOM_PASS || '');
        console.log("Resuelve el reCAPTCHA (si aparece) y dale a ENTRAR. Esperando login...");
        await page.waitForFunction(() => location.pathname.includes('/home'), { timeout: 300000 });
        console.log("Login detectado.");
        return syncLoop(page);
    } catch (err) {
        console.error("Error en prep_login:", err);
    }
}

prepareLogin();
