const puppeteer = require('puppeteer-core');
require('dotenv').config();

async function prepareLogin() {
    try {
        const browser = await puppeteer.connect({
            browserURL: 'http://127.0.0.1:9222',
            defaultViewport: null
        });

        const pages = await browser.pages();
        let page = pages.find(p => p.url().includes('pro.shalom.pe')) || await browser.newPage();
        
        await page.goto('https://pro.shalom.pe/login', { waitUntil: 'networkidle2' });
        await page.bringToFront();

        console.log("Escribiendo credenciales...");
        await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER || '');
        await page.type('#passwordLogin', process.env.SHALOM_PASS || '');
        
        console.log("CREDENCIALES LISTAS. Ahora tú debes:");
        console.log("1. Resolver el reCAPTCHA si falla automáticamente.");
        console.log("2. Hacer clic en ENTRAR.");
        console.log("3. Una vez dentro de la plataforma, avísame.");

        await browser.disconnect();
    } catch (err) {
        console.error("Error en prep_login:", err);
    }
}

prepareLogin();
