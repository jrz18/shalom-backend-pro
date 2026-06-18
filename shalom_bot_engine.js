const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Helper para capturar pantalla en caso de error
async function saveErrorState(page, stepName) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotsDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir);
        const screenshotPath = path.join(screenshotsDir, `error-${stepName}-${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[SHALOM-BOT] 📸 Captura de error guardada en: ${screenshotPath}`);
    } catch (e) {
        console.error('[SHALOM-BOT] ❌ No se pudo guardar la captura de pantalla:', e.message);
    }
}

// CLIC DE MOUSE REAL (Mejorado con selectores exactos)
async function clickReal(page, selectorOrText, label) {
    const success = await page.evaluate(async (term) => {
        // Intentar encontrar el botón que CONTENGA el texto exacto
        let el = Array.from(document.querySelectorAll('button, .btn'))
                     .find(e => e.innerText.trim().toUpperCase() === term.toUpperCase());
        
        if (!el) {
            el = document.querySelector(term) || 
                 Array.from(document.querySelectorAll('button, span, div, a, p, label'))
                      .find(e => e.innerText.trim().toUpperCase().includes(term.toUpperCase()));
        }
        
        if (!el) return { error: 'No encontrado' };
        
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true };
    }, selectorOrText);

    if (success.error) throw new Error(`No encontré "${label || selectorOrText}" para clickear`);
    
    try {
        await page.mouse.click(success.x, success.y);
        console.log(`[SHALOM-BOT]   → Clic (Mouse) en: ${label || selectorOrText}`);
    } catch (e) {
        console.log(`[SHALOM-BOT]   ⚠️ Clic Mouse falló, forzando JS para: ${label || selectorOrText}`);
        await page.evaluate((term) => {
            const el = Array.from(document.querySelectorAll('button, .btn'))
                            .find(e => e.innerText.trim().toUpperCase() === term.toUpperCase()) ||
                       Array.from(document.querySelectorAll('button, span, div, a, p, label'))
                            .find(e => e.innerText.trim().toUpperCase().includes(term.toUpperCase()));
            if (el) el.click();
        }, selectorOrText);
    }
    await delay(1500);
}

async function generarEnvioShalom(pedido, producto) {
  let browser;
  let page;
  try {
    console.log(`[SHALOM-BOT] 🚀 V6.5 (FINAL-BOSS) - PEDIDO #${pedido.id}`);
    
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });

    const pages = await browser.pages();
    page = pages[0]; 
    await page.setViewport({ width: 1366, height: 768 });

    // --- 1. LOGIN ---
    console.log("[SHALOM-BOT] Iniciando Sesión...");
    await page.goto('https://pro.shalom.pe/login', { waitUntil: 'networkidle2' });
    
    if (page.url().includes('login')) {
        await page.waitForSelector('input[placeholder="Correo electrónico"]');
        await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER);
        await page.type('#passwordLogin', process.env.SHALOM_PASS);
        await page.click('button.btn-redshalom');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    // --- 2. REGISTRO ---
    console.log("[SHALOM-BOT] Navegando a Registro...");
    await page.goto('https://pro.shalom.pe/registroindividual', { waitUntil: 'networkidle2' });
    
    // ESPERAR A QUE CARGUEN LOS PRODUCTOS (Importante!)
    await page.waitForSelector('.swiper-slide, .card, [class*="card"]', { timeout: 20000 });
    await delay(2000);

    // --- 3. SELECCIÓN DE CAJA ---
    const cajaMap = {
      'OTRA MEDIDA': 'Otra Medida',
      'SOBRE': 'Sobre',
      'PAQUETE XXS': 'Caja Paquete XXS',
      'PAQUETE XS': 'Caja Paquete XS',
      'PAQUETE S': 'Caja Paquete S',
      'PAQUETE M': 'Caja Paquete M',
      'PAQUETE L': 'Caja Paquete L',
      'PAQUETE XL': 'Caja Paquete XL'
    };
    const targetName = cajaMap[producto.caja_shalom] || 'Caja Paquete XS';
    console.log(`[SHALOM-BOT] Paso 3: Seleccionando "${targetName}"...`);
    
    let seleccionada = false;
    for (let i = 0; i < 20; i++) {
        seleccionada = await page.evaluate((name) => {
            const slides = Array.from(document.querySelectorAll('.swiper-slide, .card, [class*="card"]'));
            const target = slides.find(s => s.innerText.toUpperCase().includes(name.toUpperCase()));
            if (target) {
                const r = target.getBoundingClientRect();
                if (r.x > 10 && r.x < 1100 && r.width > 0) {
                    target.click();
                    return true;
                }
            }
            return false;
        }, targetName);

        if (seleccionada) break;
        
        await page.evaluate(() => {
            const arrow = document.querySelector('.swiper-button-next');
            if (arrow) arrow.click();
        });
        await delay(1200);
    }

    if (producto.caja_shalom === 'OTRA MEDIDA') {
        await page.waitForSelector('input[placeholder="Ancho m"]', { visible: true });
        await page.type('input[placeholder="Ancho m"]', String(producto.ancho_cm / 100));
        await page.type('input[placeholder="Largo m"]', String(producto.prof_cm / 100));
        await page.type('input[placeholder="Alto m"]', String(producto.alto_cm / 100));
        await page.type('input[placeholder="Peso kg"]', String(producto.peso_kg || 1));
        await clickReal(page, "Guardar Medidas", "Botón Guardar");
        await delay(2000);
    }

    // CONTINUAR - Con Scroll y Verificación de Cambio de Página
    console.log("[SHALOM-BOT] Haciendo clic en Continuar...");
    
    let avanzado = false;
    for (let attempt = 0; attempt < 4; attempt++) {
        await clickReal(page, "Continuar", "Botón Continuar Principal");
        await delay(4000);
        // Si aparece el multiselect, es que ya pasamos de página
        const nextStep = await page.evaluate(() => !!document.querySelector('.multiselect'));
        if (nextStep) { avanzado = true; break; }
        console.log(`[SHALOM-BOT] ⚠️ Reintento de Continuar #${attempt + 1}`);
    }

    if (!avanzado) throw new Error("Atrapado en pantalla de selección de caja - El botón Continuar no respondió");

    // --- 4. ORIGEN/DESTINO ---
    console.log("[SHALOM-BOT] Paso 4: Origen y Destino...");
    await page.waitForSelector('.multiselect', { timeout: 15000 });
    
    // Origen
    await page.evaluate(() => document.querySelectorAll('.multiselect')[0].click());
    await delay(800);
    await page.keyboard.type('LIMA LA VICTORIA');
    await delay(2500);
    await page.keyboard.press('Enter');

    // Destino
    await delay(1500);
    await page.evaluate(() => {
        const selects = document.querySelectorAll('.multiselect');
        if (selects[1]) selects[1].click();
    });
    await delay(800);
    await page.keyboard.type(pedido.agencia_destino);
    await delay(3500);
    await page.keyboard.press('Enter');
    
    // Continuar a Tarifas
    await delay(1000);
    await clickReal(page, "Continuar", "Botar a Tarifas");
    await delay(3500);
    
    // Omitir Garantía/Modales
    await page.evaluate(() => {
        const skip = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Continuar') || b.innerText.includes('Omitir'));
        if (skip) skip.click();
    });
    await delay(2000);

    // --- 5. DNI ---
    console.log(`[SHALOM-BOT] Paso 5: DNI ${pedido.cliente_dni}`);
    await page.waitForSelector('input[placeholder="DNI"]', { timeout: 15000 });
    await page.click('input[placeholder="DNI"]', { clickCount: 3 });
    await page.type('input[placeholder="DNI"]', pedido.cliente_dni);
    await delay(7000);

    if (pedido.cliente_telefono) {
        await page.evaluate(() => {
            const tel = document.querySelector('#phone-input');
            if (tel) tel.value = '';
        });
        await page.type('#phone-input', pedido.cliente_telefono);
    }
    
    await clickReal(page, "Continuar", "Confirmar Datos");
    await delay(3500);
    
    await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Continuar') || b.innerText.includes('Omitir'));
        if (btn) btn.click();
    });
    await delay(3500);

    // --- 6. PIN ---
    console.log("[SHALOM-BOT] Paso 6: PIN...");
    const pin = (process.env.SHALOM_PIN || "1812").split('');
    for (const d of pin) {
        await page.evaluate((digit) => {
            const btn = Array.from(document.querySelectorAll('button.btn-outline-default, button'))
                             .find(x => x.innerText.trim() === digit);
            if (btn) btn.click();
        }, d);
        await delay(800);
    }

    // --- 7. FINALIZAR ---
    console.log("[SHALOM-BOT] Paso 7: Generando Voucher Final...");
    let tracking = null;
    for (let i = 0; i < 4; i++) {
        await clickReal(page, "Continuar", "Generar Guía");
        await delay(8000);
        
        tracking = await page.evaluate(() => {
            const txt = document.body.innerText;
            const m = txt.match(/[V|L]\d{3}\s*[-–]\s*(\d{7,10})/i) || txt.match(/\d{8,10}/);
            return m ? m[0] : null;
        });
        
        if (tracking) break;
    }

    if (!tracking) {
        console.log("[SHALOM-BOT] ⚠️ Tracking no encontrado, buscando en envios pendientes...");
        await page.goto('https://pro.shalom.pe/enviospendientes/list', { waitUntil: 'networkidle2' });
        await delay(5000);
        tracking = await page.evaluate(() => {
            const first = document.querySelector('table tbody tr');
            if (!first) return null;
            const m = first.innerText.match(/[V|L]\d{3}\s*[-–]\s*(\d{7,10})/i) || first.innerText.match(/\d{8,10}/);
            return m ? m[0] : null;
        });
    }

    if (!tracking) {
        await saveErrorState(page, 'tracking-fail-final');
        throw new Error("No se pudo obtener el N° de seguimiento final");
    }
    
    console.log(`[SHALOM-BOT] 🎉 EXITO: ${tracking}`);
    await browser.close();
    return { n_orden: tracking, cod_seguimiento: 'SHALOM' };

  } catch (err) {
    console.error('[BOT ERROR]', err.message);
    if (page) await saveErrorState(page, 'fatal-error');
    if (browser) await browser.close();
    throw err;
  }
}

module.exports = { generarEnvioShalom };
