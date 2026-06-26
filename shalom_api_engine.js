const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
require('dotenv').config();

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// API key pública de la firma anti-bot de Shalom (está fija en su frontend)
const API_KEY_FIRMA = 'pk_over_5pg91gO6CSgmT627cf2sC8B7dqjxcLFQhW7HhnitKq3';

// ===================== CONFIGURACIÓN =====================
// Remitente fijo (la cuenta que envía). Sale del .env si existe.
const REMITENTE_ID = Number(process.env.SHALOM_REMITENTE_ID || 3386670);
const REMITENTE_DNI = String(process.env.SHALOM_REMITENTE_DNI || "47648778");

// Agencia de ORIGEN fija (de dónde sale el paquete). Configurable por .env.
// Se busca por nombre contra la lista de agencias de Shalom.
const ORIGEN_AGENCIA = process.env.SHALOM_ORIGEN || "CANTO GRANDE";

// Orígenes conocidos -> ter_id (evita depender de /envia_ya/terminals que a veces falla)
const ORIGENES = {
    'LOS PINOS': { ter_id: 411, lugar_over: 'LOS PINOS' },
    'CANTO GRANDE': { ter_id: 410, lugar_over: 'CANTO GRANDE' },
    'AV. PRINCIPAL': { ter_id: 432, lugar_over: 'AV. PRINCIPAL' },
    'AV PRINCIPAL': { ter_id: 432, lugar_over: 'AV. PRINCIPAL' }
};

// Declaración jurada del contenido (obligatoria en Shalom).
const DECLARACION_JURADA = process.env.SHALOM_DECLARACION || "Electrodomesticos";

// caja_shalom (como está en tu BD) -> título exacto del producto en Shalom
const CAJA_A_TITULO = {
    'SOBRE': 'Sobre',
    'PAQUETE XXS': 'Caja Paquete XXS',
    'PAQUETE XS': 'Caja Paquete XS',
    'PAQUETE S': 'Caja Paquete S',
    'PAQUETE M': 'Caja Paquete M',
    'PAQUETE L': 'Caja Paquete L',
    'OTRA MEDIDA': 'Otra Medida'
};
// ========================================================

class ShalomAPI {
    constructor() {
        this.cookies = "";
        this.xsrfToken = "";
        this.baseUrl = "https://pro.shalom.pe";
    }

    async loadRemoteSession() {
        try {
            console.log("[API-ENGINE] Intentando cargar sesion remota desde Supabase...");
            const { createClient } = require('@supabase/supabase-js');
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
            const { data, error } = await supabase.from('bot_session').select('*').eq('id', 1).single();
            
            if (error || !data || !data.cookies) {
                console.log("[API-ENGINE] No hay sesion remota valida.");
                return false;
            }

            this.cookies = data.cookies;
            this.xsrfToken = data.xsrf_token;
            this.apiSecret = data.api_secret;
            this.responseKey = data.response_key;
            console.log("[API-ENGINE] Sesion remota cargada con exito.");
            return true;
        } catch (e) {
            console.log("[API-ENGINE] Aviso: Error cargando sesion remota:", e.message);
            return false;
        }
    }

    async login() {
        // Primero intentamos cargar la sesion remota para evitar el login (bypass reCAPTCHA)
        const remote = await this.loadRemoteSession();
        if (remote) return;

        // En la nube no hay navegador: si no hay sesion remota valida, fallar claro (la PC local
        // debe re-sincronizar con prep_login). Evita intentar un puppeteer.launch que no funciona alla.
        if (process.env.SHALOM_NO_LAUNCH === '1') {
            throw new Error("Sesion remota invalida/expirada en Supabase. La PC local debe re-sincronizar (prep_login).");
        }

        console.log("[API-ENGINE] Iniciando sesion manual (Puppeteer)...");
        const browser = await puppeteer.launch({
            executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            timeout: 60000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
        });
        const page = await browser.newPage();
        await page.goto(`${this.baseUrl}/login`, { waitUntil: 'networkidle2' });
        await page.type('input[placeholder="Correo electrónico"]', process.env.SHALOM_USER);
        await page.type('#passwordLogin', process.env.SHALOM_PASS);
        await page.click('button.btn-redshalom');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        const cookiesObj = await page.cookies();
        this.cookies = cookiesObj.map(c => `${c.name}=${c.value}`).join('; ');
        const xsrfCookie = cookiesObj.find(c => c.name === 'XSRF-TOKEN');
        this.xsrfToken = decodeURIComponent(xsrfCookie.value);

        const metas = await page.evaluate(() => ({
            apiSecret: (document.querySelector('meta[name="api-secret"]') || {}).content || null,
            responseKey: (document.querySelector('meta[name="response-key"]') || {}).content || null
        }));
        this.apiSecret = metas.apiSecret;
        this.responseKey = metas.responseKey;
        console.log(`[API-ENGINE] Sesion obtenida (firma: ${this.apiSecret ? 'si' : 'NO'})`);
        await browser.close();
    }

    async request(path, body = {}, method = 'POST') {
        const url = `${this.baseUrl}${path}`;
        console.log(`[API-DEBUG] → ${method} ${path}`);

        // Firma anti-bot de Shalom: mensaje = METHOD + path(sin "/") + timestamp + nonce; firma = HMAC-SHA256(mensaje, apiSecret)
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = Math.random().toString(36).substring(2, 10);
        const mensaje = method.toUpperCase() + path.replace(/^\//, '') + timestamp + nonce;
        const signature = this.apiSecret
            ? crypto.createHmac('sha256', this.apiSecret).update(mensaje).digest('hex')
            : '';

        const options = {
            method,
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Accept': 'application/json',
                'X-XSRF-TOKEN': this.xsrfToken,
                'Cookie': this.cookies,
                'x-requested-with': 'XMLHttpRequest',
                'X-API-KEY': API_KEY_FIRMA,
                'X-TIMESTAMP': String(timestamp),
                'X-NONCE': nonce,
                'X-SIGNATURE': signature
            }
        };
        if (method === 'POST') options.body = JSON.stringify(body);
        const response = await fetch(url, options);
        let data = await response.json();
        // Shalom ahora ENCRIPTA las respuestas: {encrypted:true, data:"..."} -> descifrar
        if (data && data.encrypted === true && data.data) {
            data = this.decrypt(data.data) || data;
        }
        console.log(`[API-DEBUG] ← ${path} [success: ${data.success}]`);
        return data;
    }

    // Descifra respuestas de Shalom: AES-256-CBC, IV = primeros 16 bytes, key = response-key (base64)
    decrypt(dataB64) {
        try {
            const raw = Buffer.from(dataB64, 'base64');
            const iv = raw.subarray(0, 16);
            const ciphertext = raw.subarray(16);
            const key = Buffer.from(this.responseKey, 'base64');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            const dec = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
            return JSON.parse(dec);
        } catch (e) {
            console.log('[API-ENGINE] Aviso: No se pudo descifrar la respuesta:', e.message);
            return null;
        }
    }

    // Busca el ter_id de una agencia por nombre (difuso)
    findTerminal(terminals, searchName) {
        if (!searchName) return null;
        const s = searchName.toUpperCase().trim();
        const words = s.split(/\s+/).filter(w => w.length > 2);

        // 1) coincidencia exacta por lugar_over
        let t = terminals.find(x => (x.lugar_over || '').toUpperCase() === s);
        // 2) el nombre completo contiene el texto buscado
        if (!t) t = terminals.find(x => (x.nombre || '').toUpperCase().includes(s));
        // 3) el nombre contiene TODAS las palabras clave
        if (!t) t = terminals.find(x => words.every(w => (x.nombre || '').toUpperCase().includes(w)));
        return t || null;
    }

    // Consulta el nombre OFICIAL (RENIEC) a partir del DNI. Devuelve {apellidos, nombres} o null.
    async getNombreOficial(dni) {
        try {
            const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
            if (process.env.DNI_API_TOKEN) headers['Authorization'] = `Bearer ${process.env.DNI_API_TOKEN}`;
            const r = await fetch(`https://api.apis.net.pe/v1/dni?numero=${encodeURIComponent(dni)}`, { headers });
            if (!r.ok) return null;
            const d = await r.json();
            if (!d || !d.nombres) return null;
            return {
                apellidos: `${d.apellidoPaterno || ''} ${d.apellidoMaterno || ''}`.trim(),
                apellidoPaterno: d.apellidoPaterno || '',
                apellidoMaterno: d.apellidoMaterno || '',
                nombres: String(d.nombres).trim()
            };
        } catch (e) {
            console.log(`[API-ENGINE] Aviso: No se pudo consultar RENIEC (DNI ${dni}): ${e.message}`);
            return null;
        }
    }

    // Devuelve el destinatario_uuid (API nueva /service-orders/recipients). Si el destinatario no
    // esta en la cuenta, lo registra con recipients/save (nombre oficial RENIEC) y devuelve el uuid.
    async obtenerDestinatarioUuid(pedido) {
        const dni = String(pedido.cliente_dni);

        // 1) Buscar el contacto en tu cuenta -> devuelve su uuid
        let r = await this.request('/service-orders/recipients/search', { document: dni });
        if (r && r.success && r.data && r.data.uuid) {
            console.log(`[API-ENGINE] Destinatario encontrado (uuid ${r.data.uuid})`);
            return r.data.uuid;
        }

        // 2) No existe -> registrarlo. Nombres por RENIEC: first_name=nombres, last_name=ap.paterno, surname=ap.materno
        const oficial = await this.getNombreOficial(dni);
        const tokens = String(pedido.cliente_nombre || '').trim().split(/\s+/).filter(Boolean);
        const body = {
            document: dni,
            first_name: (oficial && oficial.nombres) || tokens.slice(0, 2).join(' ') || 'CLIENTE',
            last_name: (oficial && oficial.apellidoPaterno) || tokens[2] || tokens[0] || '',
            surname: (oficial && oficial.apellidoMaterno) || tokens[3] || '',
            phone: String(pedido.cliente_telefono || "999999999")
        };
        console.log(`[API-ENGINE] Registrando destinatario nuevo DNI ${dni} (recipients/save)...`);
        const saved = await this.request('/service-orders/recipients/save', body);
        let uuid = (saved && saved.data && saved.data.uuid) ? saved.data.uuid : (saved && saved.uuid) ? saved.uuid : null;
        if (!uuid) {
            r = await this.request('/service-orders/recipients/search', { document: dni });
            uuid = (r && r.data && r.data.uuid) ? r.data.uuid : null;
        }
        if (!uuid) throw new Error(`No se pudo registrar al destinatario (DNI ${dni}): ${(saved && saved.message) || 'sin uuid'}`);
        console.log(`[API-ENGINE] Destinatario registrado (uuid ${uuid})`);
        return uuid;
    }

    // Obtiene info del producto (id, nombre, detalle, clave de tarifa)
    async getProductInfo(cajaShalom) {
        const res = await this.request('/envia_ya/products');
        const list = res.data || [];
        const titulo = CAJA_A_TITULO[String(cajaShalom || '').toUpperCase()] || 'Sobre';
        const prod = list.find(p => p.title === titulo) || list.find(p => p.title === 'Sobre');
        return {
            id: prod.id,
            name: prod.title,
            detalle: prod.content || "",
            tariffKey: prod.title.toLowerCase().replace(/\s+/g, '')  // "Caja Paquete L" -> "cajapaquetel"
        };
    }

    async generateOrder(pedido, producto) {
        try {
            await this.login();

            // 1. Agencias origen y destino -> ter_id
            // ORIGEN: del mapa de orígenes conocidos. DESTINO: del agencia_id del pedido.
            // Solo si falta resolver algo por NOMBRE traemos la lista de Shalom (con reintentos).
            const origenNombre = (pedido.origen_agencia || ORIGEN_AGENCIA || '').toUpperCase().trim();
            let origen = ORIGENES[origenNombre] || null;
            let destino = pedido.agencia_id
                ? { ter_id: Number(pedido.agencia_id), lugar_over: pedido.agencia_destino || String(pedido.agencia_id) }
                : null;

            if (!origen || !destino) {
                let terminals = [];
                for (let intento = 1; intento <= 4; intento++) {
                    const t = await this.request('/envia_ya/terminals');
                    if (t && Array.isArray(t.Map) && t.Map.length) { terminals = t.Map; break; }
                    console.log(`[API-ENGINE] Aviso: Lista de agencias vacia (intento ${intento}/4), reintentando...`);
                    await delay(2500);
                }
                if (!terminals.length) throw new Error('Shalom no devolvió la lista de agencias (reintenta en un momento)');
                if (!origen) { const o = this.findTerminal(terminals, origenNombre); if (o) origen = { ter_id: o.ter_id, lugar_over: o.lugar_over }; }
                if (!destino) { const d = this.findTerminal(terminals, pedido.agencia_destino); if (d) destino = { ter_id: d.ter_id, lugar_over: d.lugar_over }; }
            }
            if (!origen) throw new Error(`No encontré la agencia de ORIGEN "${origenNombre}"`);
            if (!destino) throw new Error(`No encontré la agencia de DESTINO "${pedido.agencia_destino}"`);
            console.log(`[API-ENGINE] Origen ${origen.ter_id} (${origen.lugar_over}) -> Destino ${destino.ter_id} (${destino.lugar_over})`);

            // 2. Destinatario -> uuid (API nueva)
            const destinatarioUuid = await this.obtenerDestinatarioUuid(pedido);

            // 3. Producto
            const prodInfo = await this.getProductInfo(producto.caja_shalom);
            const esOtraMedida = prodInfo.name.toUpperCase().includes('OTRA MEDIDA');

            // 4. Dimensiones: solo "Otra Medida" las manda (en metros; peso en kg). Cajas fijas van vacías.
            const dims = { ancho: "", alto: "", largo: "", peso: "" };
            if (esOtraMedida) {
                dims.ancho = String((Number(producto.ancho_cm) || 0) / 100);
                dims.alto = String((Number(producto.alto_cm) || 0) / 100);
                dims.largo = String((Number(producto.prof_cm) || 0) / 100);
                dims.peso = String(Number(producto.peso_kg) || 0);
            }

            // 5. Tarifa real (con dimensiones si es Otra Medida)
            const tarifaRes = await this.request('/envia_ya/tariff/calculate', {
                origin: origen.ter_id,
                destiny: String(destino.ter_id),
                width: dims.ancho, height: dims.alto, length: dims.largo, weight: dims.peso
            });
            if (!tarifaRes.success || !tarifaRes.data) throw new Error("No se pudo calcular la tarifa");

            let costo;
            if (esOtraMedida) {
                // Otra Medida: el precio lo da data.price (calculado por volumen/peso)
                costo = Number(tarifaRes.data.price).toFixed(2);
            } else {
                const precio = tarifaRes.data.tariff[prodInfo.tariffKey];
                if (precio == null) throw new Error(`Shalom no tiene tarifa "${prodInfo.tariffKey}" para esta ruta`);
                costo = Number(precio).toFixed(2);
            }
            console.log(`[API-ENGINE] Tarifa ${prodInfo.name}: S/ ${costo}`);

            // 6. Crear la orden (formato NUEVO: destinatario_uuid, sin ids numericos ni remitente;
            // el remitente es implicito de la sesion). declaracion_jurada ya no es obligatoria.
            const payload = {
                origen: origen.ter_id,
                destino: Number(destino.ter_id),
                tipo_pago: process.env.SHALOM_TIPO_PAGO || "DESTINATARIO",
                tipo_producto: prodInfo.id,
                tipo_producto_json: { value: costo, name: prodInfo.name, detalle: esOtraMedida ? "" : prodInfo.detalle },
                cantidad: 1,
                peso: dims.peso, alto: dims.alto, largo: dims.largo, ancho: dims.ancho,
                costo: costo,
                destinatario_uuid: destinatarioUuid,
                garantia: 0,
                garantia_costo: 0,
                garantia_monto: "0.00",
                contact_extra_uuid: null,
                contacto_doc: "",
                grrs: "[]",
                clave: String(process.env.SHALOM_PIN || "1812"),
                aereo: 0,
                servicio_cobranza: 0,
                servicio_cobranza_costo: 0,
                declaracion_jurada: process.env.SHALOM_DECLARACION || ""
            };

            console.log("[API-ENGINE] Enviando orden de envio...");
            let result = await this.request('/envia_ya/service_order/save', payload);

            // Respaldo: si Shalom rechaza por el modo de servicio, reintentar con el otro (terrestre <-> aéreo)
            if (!result.success && /a[eé]reo|terrestre|servicio/i.test(result.message || '')) {
                payload.aereo = payload.aereo ? 0 : 1;
                console.log(`[API-ENGINE] Modo de servicio rechazado; reintentando con aereo=${payload.aereo}...`);
                result = await this.request('/envia_ya/service_order/save', payload);
            }

            if (result.success && result.data) {
                const nOrden = `${result.data.serie}-${result.data.guia}`;
                console.log(`[API-ENGINE] EXITO: Guia ${nOrden} (cod ${result.data.codigo})`);
                return {
                    n_orden: nOrden,
                    cod_seguimiento: result.data.codigo,
                    costo: Number(costo)
                };
            }

            console.log("[API-ENGINE] Respuesta:", JSON.stringify(result));
            throw new Error(result.message || "Error desconocido al crear la orden");
        } catch (err) {
            console.error("[API-ENGINE] Fallo:", err.message);
            throw err;
        }
    }
}

async function generarEnvioShalomAPI(pedido, producto) {
    const api = new ShalomAPI();
    return await api.generateOrder(pedido, producto);
}

module.exports = { generarEnvioShalomAPI, ShalomAPI };
