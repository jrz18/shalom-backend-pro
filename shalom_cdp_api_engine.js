const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
require('dotenv').config();

class ShalomCDP {
    constructor() {
        this.browser = null;
        this.page = null;
        this.baseUrl = 'https://pro.shalom.pe';
        this.apiSecret = null;
        this.responseKey = null;
        this.xsrfToken = null;
    }

    async init() {
        console.log("[CDP] Conectando a Chrome (9222)...");
        this.browser = await puppeteer.connect({
            browserURL: 'http://127.0.0.1:9222',
            defaultViewport: null
        });

        const pages = await this.browser.pages();
        this.page = pages.find(p => p.url().includes('pro.shalom.pe')) || await this.browser.newPage();
        
        if (!this.page.url().includes('pro.shalom.pe')) {
            await this.page.goto(this.baseUrl, { waitUntil: 'networkidle2' });
        }

        await this.page.bringToFront();
        await this.refreshMetadata();
    }

    async refreshMetadata() {
        console.log("[CDP] Actualizando metadatos (XSRF, Secretos)...");
        const meta = await this.page.evaluate(() => {
            const getCookie = (name) => {
                const value = `; ${document.cookie}`;
                const parts = value.split(`; ${name}=`);
                if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
                return null;
            };

            return {
                apiSecret: (document.querySelector('meta[name="api-secret"]') || {}).content || null,
                responseKey: (document.querySelector('meta[name="response-key"]') || {}).content || null,
                xsrfToken: getCookie('XSRF-TOKEN')
            };
        });

        this.apiSecret = meta.apiSecret;
        this.responseKey = meta.responseKey;
        this.xsrfToken = meta.xsrfToken;

        if (!this.xsrfToken) {
            console.log("[CDP] Aviso: No se encontro XSRF-TOKEN. ¿Estas logueado?");
            return false;
        }
        console.log("[CDP] Metadatos listos.");

        // PERSISTENCIA HIBRIDA: Guardar en Supabase para Cloud Run
        try {
            const { createClient } = require('@supabase/supabase-js');
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
            // IMPORTANTE: page.cookies() incluye las cookies HttpOnly (enviashalom_session, la de login),
            // que document.cookie NO devuelve. Sin esa cookie, la nube recibia la sesion sin login -> 401.
            const fullCookies = (await this.page.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
            await supabase.from('bot_session').update({
                cookies: fullCookies,
                xsrf_token: this.xsrfToken,
                api_secret: this.apiSecret,
                response_key: this.responseKey,
                updated_at: new Date().toISOString()
            }).eq('id', 1);
            console.log("[CDP] Sesion sincronizada en la nube (Hybrid OK)");
        } catch (e) {
            console.log("[CDP] Aviso: No se pudo subir la sesion a la nube (¿Creaste la tabla bot_session?):", e.message);
        }

        return true;
    }

    async request(path, body = {}, method = 'POST') {
        if (!this.apiSecret) await this.refreshMetadata();

        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = Math.random().toString(36).substring(2, 10);
        const mensaje = method.toUpperCase() + path.replace(/^\//, '') + timestamp + nonce;
        const signature = this.apiSecret
            ? crypto.createHmac('sha256', this.apiSecret).update(mensaje).digest('hex')
            : '';

        console.log(`[CDP-REQ] → ${method} ${path}`);

        const result = await this.page.evaluate(async (url, options) => {
            try {
                const response = await fetch(url, options);
                const data = await response.json();
                return { ok: response.ok, status: response.status, data };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }, `${this.baseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Accept': 'application/json',
                'X-XSRF-TOKEN': this.xsrfToken,
                'x-requested-with': 'XMLHttpRequest',
                'X-API-KEY': 'pk_over_5pg91gO6CSgmT627cf2sC8B7dqjxcLFQhW7HhnitKq3',
                'X-TIMESTAMP': String(timestamp),
                'X-NONCE': nonce,
                'X-SIGNATURE': signature
            },
            body: method === 'POST' ? JSON.stringify(body) : undefined
        });

        if (!result.ok) {
            console.error(`[CDP-REQ] Error ${result.status}:`, result.error || result.data);
            return result.data || { success: false, message: result.error };
        }

        let data = result.data;
        if (data && data.encrypted === true && data.data) {
            data = this.decrypt(data.data) || data;
        }
        
        console.log(`[CDP-REQ] ← ${path} [success: ${data.success}]`);
        return data;
    }

    decrypt(dataB64) {
        try {
            const raw = Buffer.from(dataB64, 'base64');
            const iv = raw.subarray(0, 16);
            const ciphertext = raw.subarray(16);
            const key = Buffer.from(this.responseKey, 'base64');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let dec = decipher.update(ciphertext, undefined, 'utf8');
            dec += decipher.final('utf8');
            return JSON.parse(dec);
        } catch (e) {
            console.log('[CDP] Aviso: Error descifrando:', e.message);
            return null;
        }
    }

    async close() {
        if (this.browser) await this.browser.disconnect();
    }
}

// Nombre oficial RENIEC por DNI (apis.net.pe). first_name=nombres, last_name=ap.paterno, surname=ap.materno.
async function getNombreOficial(dni) {
    try {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
        if (process.env.DNI_API_TOKEN) headers['Authorization'] = `Bearer ${process.env.DNI_API_TOKEN}`;
        const r = await fetch(`https://api.apis.net.pe/v1/dni?numero=${encodeURIComponent(dni)}`, { headers });
        if (!r.ok) return null;
        const d = await r.json();
        if (!d || !d.nombres) return null;
        return { apellidoPaterno: d.apellidoPaterno || '', apellidoMaterno: d.apellidoMaterno || '', nombres: String(d.nombres).trim() };
    } catch (e) { return null; }
}

async function generarEnvioShalomCDP(pedido, producto) {
    const api = new ShalomCDP();
    try {
        await api.init();
        const success = await api.refreshMetadata();
        if (!success) throw new Error("No se pudo sincronizar la sesion con Chrome. ¿Estas logueado en pro.shalom.pe?");
        
        // 1. Agencias: origen por nombre (mapa conocido), destino = ter_id del pedido.
        const ORIGENES = { 'LOS PINOS': 411, 'CANTO GRANDE': 410, 'AV. PRINCIPAL': 432, 'AV PRINCIPAL': 432 };
        const origenNombre = String(pedido.origen_agencia || process.env.SHALOM_ORIGEN || 'CANTO GRANDE').toUpperCase().trim();
        const origen_id = ORIGENES[origenNombre] || Number(process.env.SHALOM_ORIGEN_ID || 410);
        const destino_id = Number(pedido.agencia_id || 203);

        // 2. Info de producto e Identificadores
        const prodId = producto.id || 5; 
        const esOtraMedida = producto.caja_shalom === 'OTRA MEDIDA';
        const dims = {
            ancho: esOtraMedida ? String((Number(producto.ancho_cm) || 0) / 100) : "",
            alto: esOtraMedida ? String((Number(producto.alto_cm) || 0) / 100) : "",
            largo: esOtraMedida ? String((Number(producto.prof_cm) || 0) / 100) : "",
            peso: esOtraMedida ? String(Number(producto.peso_kg) || 0) : ""
        };

        // 3. DESTINATARIO -> destinatario_uuid (API NUEVA: /service-orders/recipients).
        // La API nueva ya NO usa remitente_id/destinatario_id numéricos; el remitente es implícito
        // de la sesión. El order solo necesita destinatario_uuid, que sale de recipients/search.
        // Si el destinatario no está en tu cuenta, se registra con recipients/save (devuelve uuid).
        const dni = String(pedido.cliente_dni);
        console.log(`[CDP] Buscando destinatario DNI ${dni} (recipients/search)...`);
        let rsearch = await api.request('/service-orders/recipients/search', { document: dni });
        let destinatarioUuid = (rsearch && rsearch.success && rsearch.data && rsearch.data.uuid) ? rsearch.data.uuid : null;

        if (!destinatarioUuid) {
            console.log(`[CDP] Destinatario no registrado en tu cuenta; creándolo (recipients/save)...`);
            const ofi = await getNombreOficial(dni);
            const tk = String(pedido.cliente_nombre || '').trim().split(/\s+/).filter(Boolean);
            const body = {
                document: dni,
                first_name: (ofi && ofi.nombres) || tk.slice(0, 2).join(' ') || 'CLIENTE',
                last_name: (ofi && ofi.apellidoPaterno) || tk[2] || tk[0] || '',
                surname: (ofi && ofi.apellidoMaterno) || tk[3] || '',
                phone: String(pedido.cliente_telefono || '999999999')
            };
            const saved = await api.request('/service-orders/recipients/save', body);
            destinatarioUuid = (saved && saved.data && saved.data.uuid) ? saved.data.uuid
                             : (saved && saved.uuid) ? saved.uuid : null;
            if (!destinatarioUuid) {
                rsearch = await api.request('/service-orders/recipients/search', { document: dni });
                destinatarioUuid = (rsearch && rsearch.data && rsearch.data.uuid) ? rsearch.data.uuid : null;
            }
            if (!destinatarioUuid) throw new Error("No se pudo registrar al destinatario: " + ((saved && saved.message) || 'sin uuid'));
        }
        console.log(`[CDP] Destinatario uuid: ${destinatarioUuid}`);

        // 4. Tarifa
        const tarifaRes = await api.request('/envia_ya/tariff/calculate', {
            origin: origen_id,
            destiny: destino_id,
            width: dims.ancho, height: dims.alto, length: dims.largo, weight: dims.peso
        });
        if (!tarifaRes.success || !tarifaRes.data) throw new Error("Fallo al calcular tarifa");
        let costo;
        if (esOtraMedida) {
            costo = Number(tarifaRes.data.price || 0).toFixed(2);
        } else {
            const t = tarifaRes.data.tariff || {};
            const key = String(producto.caja_shalom || '').toLowerCase().replace(/\s+/g, '').replace('paquete', 'cajapaquete');
            const precio = t[key] != null ? t[key] : (tarifaRes.data.price || t.sobre || 0);
            costo = Number(precio).toFixed(2);
        }

        // 5. Orden — formato NUEVO (capturado de la web): destinatario_uuid + contact_extra_uuid,
        // sin remitente/destinatario numéricos. declaracion_jurada ya NO es obligatoria (puede ir "").
        const payload = {
            origen: Number(origen_id),
            destino: Number(destino_id),
            tipo_pago: process.env.SHALOM_TIPO_PAGO || "DESTINATARIO",
            tipo_producto: Number(prodId),
            tipo_producto_json: { value: costo, name: (producto.nombre_corto || "PAQUETE").toUpperCase(), detalle: "" },
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

        console.log("[CDP] Creando guía (service_order/save)...");
        console.log("[CDP][DIAG] ORDER payload =", JSON.stringify(payload));
        let result = await api.request('/envia_ya/service_order/save', payload);

        // Respaldo: si rechaza por el modo de servicio, reintentar con el otro (terrestre <-> aéreo).
        if ((!result || !result.success) && /a[eé]reo|terrestre|servicio/i.test((result && result.message) || '')) {
            payload.aereo = payload.aereo ? 0 : 1;
            console.log(`[CDP] Modo de servicio rechazado; reintentando con aereo=${payload.aereo}...`);
            result = await api.request('/envia_ya/service_order/save', payload);
        }

        if (!result || !result.success) {
            const msg = result ? (result.message || "Error desconocido") : "Fallo de respuesta";
            console.error("[CDP] Fallo en la API de Shalom:", msg);
            throw new Error(msg);
        }

        return {
            n_orden: `${result.data.serie}-${result.data.guia}`,
            cod_seguimiento: result.data.codigo,
            costo: costo
        };
    } finally {
        await api.close();
    }
}

module.exports = { ShalomCDP, generarEnvioShalomCDP };
