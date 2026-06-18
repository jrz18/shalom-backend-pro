const puppeteer = require('puppeteer-core');
require('dotenv').config();
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Estado de Shalom (rastreo real) -> estado del dashboard
const MAP_ESTADO = {
    'en origen': 'ENVIADO',
    'en transito': 'EN_TRANSITO',
    'en tránsito': 'EN_TRANSITO',
    'en reparto': 'EN_TRANSITO',
    'en destino': 'EN_DESTINO',
    'entregado': 'ENTREGADO'
};

// "V225-85147898" -> "85147898" ; "84459765" -> "84459765"
function getGuia(nOrden) {
    if (!nOrden) return null;
    const parts = String(nOrden).split('-');
    const last = parts[parts.length - 1].replace(/\D/g, '');
    return last || null;
}

// Lee el estado REAL de cada pedido rastreable desde shalom.com.pe/rastrea.
// Devuelve [{ id, n_orden, antes, ahora, shalom }] SOLO de los que cambiaron.
async function leerEstadosRastreo(pedidos) {
    // Solo rastreables: ENVIADO / EN_TRANSITO / EN_DESTINO, con guía y código.
    // (Los ENTREGADO no se tocan; PENDIENTE/ERROR no tienen guía.)
    const rastreables = pedidos.filter(p =>
        ['ENVIADO', 'EN_TRANSITO', 'EN_DESTINO'].includes(p.estado) &&
        getGuia(p.n_orden) && p.cod_seguimiento
    );
    if (rastreables.length === 0) return [];

    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const cambios = [];

    try {
        const page = await browser.newPage();

        // --- LOGIN en el rastreo (usa la cuenta de Shalom Pro) ---
        await page.goto('https://shalom.com.pe/rastrea', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(4000);
        await page.type('input[type="email"]', process.env.SHALOM_USER, { delay: 20 });
        await page.type('input[type="password"]', process.env.SHALOM_PASS, { delay: 20 });
        await page.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => /ingresar|inicia/i.test(x.innerText));
            if (b) b.click();
        });
        await delay(5000);
        console.log(`[RASTREO] Sesión iniciada. Rastreando ${rastreables.length} pedidos...`);

        // --- Rastrear uno por uno ---
        for (const p of rastreables) {
            const guia = getGuia(p.n_orden);
            try {
                await page.goto('https://shalom.com.pe/rastrea', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(3000);
                const inputs = await page.$$('input');
                if (inputs.length >= 2) {
                    await inputs[0].click({ clickCount: 3 }); await inputs[0].type(guia, { delay: 15 });
                    await inputs[1].click({ clickCount: 3 }); await inputs[1].type(String(p.cod_seguimiento), { delay: 15 });
                }
                await page.evaluate(() => {
                    const b = Array.from(document.querySelectorAll('button')).find(x => /buscar/i.test(x.innerText));
                    if (b) b.click();
                });
                await delay(4500);

                const txt = await page.evaluate(() => document.body.innerText);
                const m = txt.match(/En origen|En tr[aá]nsito|En reparto|En destino|Entregado/i);
                const shalomEstado = m ? m[0] : null;
                const nuevo = shalomEstado ? MAP_ESTADO[shalomEstado.toLowerCase()] : null;

                console.log(`[RASTREO] ${p.n_orden} (${p.cod_seguimiento}) -> ${shalomEstado || 'sin estado'}`);
                if (nuevo && nuevo !== p.estado) {
                    cambios.push({ id: p.id, n_orden: p.n_orden, antes: p.estado, ahora: nuevo, shalom: shalomEstado });
                }
            } catch (e) {
                console.log(`[RASTREO] ⚠️ error con ${p.n_orden}: ${e.message}`);
            }
        }
    } finally {
        await browser.close();
    }

    return cambios;
}

module.exports = { leerEstadosRastreo, getGuia };
