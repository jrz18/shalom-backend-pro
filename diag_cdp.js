const puppeteer = require('puppeteer-core');

async function testCDP() {
    try {
        console.log("Intentando conectar a Chrome en puerto 9222...");
        const browser = await puppeteer.connect({
            browserURL: 'http://127.0.0.1:9222',
            defaultViewport: null
        });

        const pages = await browser.pages();
        console.log(`Páginas abiertas: ${pages.length}`);
        
        let shalomPage = pages.find(p => p.url().includes('pro.shalom.pe'));
        
        if (!shalomPage) {
            console.log("No encontré pestaña de Shalom. Abriendo una nueva...");
            shalomPage = await browser.newPage();
            await shalomPage.goto('https://pro.shalom.pe/login', { waitUntil: 'networkidle2' });
        } else {
            console.log(`Pestaña Shalom encontrada: ${shalomPage.url()}`);
            await shalomPage.bringToFront();
        }

        const title = await shalomPage.title();
        console.log(`Título de la página: ${title}`);

        const isLoggedIn = await shalomPage.evaluate(() => {
            return !window.location.href.includes('/login');
        });

        console.log(`¿Está logueado?: ${isLoggedIn}`);
        
        if (!isLoggedIn) {
            console.log("RECUERDA: Debes loguearte manualmente en la ventana de Chrome que se abrió.");
        } else {
            // Intentar un request simple desde la consola de la página
            console.log("Probando request de prueba (terminales)...");
            const terminals = await shalomPage.evaluate(async () => {
                try {
                    const res = await fetch('/envia_ya/terminals', {
                        method: 'POST',
                        headers: {
                            'X-XSRF-TOKEN': decodeURIComponent(document.cookie.split('; ').find(row => row.startsWith('XSRF-TOKEN=')).split('=')[1]),
                            'Accept': 'application/json',
                            'x-requested-with': 'XMLHttpRequest'
                        }
                    });
                    return await res.json();
                } catch (e) {
                    return { error: e.message };
                }
            });
            console.log("Respuesta de terminales recibida correctamente (cifrada o no).");
        }

        await browser.disconnect();
    } catch (err) {
        console.error("Error conectando a CDP:", err);
    }
}

testCDP();
