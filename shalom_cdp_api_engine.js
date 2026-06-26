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
            console.log("[CDP] ⚠️ No se encontró XSRF-TOKEN. ¿Estás logueado?");
            return false;
        }
        console.log("[CDP] ✅ Metadatos listos.");
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
            console.error(`[CDP-REQ] ❌ Error ${result.status}:`, result.error || result.data);
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
            console.log('[CDP] ⚠️ Error descifrando:', e.message);
            return null;
        }
    }

    async close() {
        if (this.browser) await this.browser.disconnect();
    }
}

async function generarEnvioShalomCDP(pedido, producto) {
    const api = new ShalomCDP();
    try {
        await api.init();
        const success = await api.refreshMetadata();
        if (!success) throw new Error("No se pudo sincronizar la sesión con Chrome. ¿Estás logueado en pro.shalom.pe?");
        
        // Mapeo de datos para que coincida con lo que espera el motor original
        // 1. Agencias
        const origen_id = 411; // Los Pinos por defecto
        const destino_id = pedido.agencia_id || 203;

        // 2. Info de producto
        const prodId = producto.id || 5; 

        const esOtraMedida = producto.caja_shalom === 'OTRA MEDIDA';
        const dims = {
            ancho: esOtraMedida ? String((Number(producto.ancho_cm) || 0) / 100) : "",
            alto: esOtraMedida ? String((Number(producto.alto_cm) || 0) / 100) : "",
            largo: esOtraMedida ? String((Number(producto.prof_cm) || 0) / 100) : "",
            peso: esOtraMedida ? String(Number(producto.peso_kg) || 0) : ""
        };

        // 3. Tarifa
        const tarifaRes = await api.request('/envia_ya/tariff/calculate', {
            origin: origen_id,
            destiny: String(destino_id),
            width: dims.ancho, height: dims.alto, length: dims.largo, weight: dims.peso
        });
        if (!tarifaRes.success) throw new Error("Fallo al calcular tarifa");
        const costo = Number(tarifaRes.data.price || tarifaRes.data.tariff?.sobre || 0).toFixed(2);

        // 4. Crear Orden
        const payload = {
            origen: origen_id,
            destino: String(destino_id),
            tipo_pago: "DESTINATARIO",
            tipo_producto: prodId,
            tipo_producto_json: { value: costo, name: producto.nombre_corto || "Sobre", detalle: "" },
            cantidad: 1,
            peso: dims.peso, alto: dims.alto, largo: dims.largo, ancho: dims.ancho,
            costo: costo,
            remitente: "47648778",
            destinatario: String(pedido.cliente_dni),
            remitente_id: 3386670,
            destinatario_id: null,
            garantia: 0,
            garantia_costo: 0,
            garantia_monto: "0.00",
            contacto_doc: "",
            grrs: "[]",
            clave: "1812",
            aereo: 0,
            servicio_cobranza: 0,
            servicio_cobranza_costo: 0,
            servicio_cobranza_datos: JSON.stringify({ document: "", name: "", bank: "", type_account: "", account_number: "", cci: "" }),
            declaracion_jurada: "Electrodomesticos"
        };

        // Registrar destinatario antes si no existe
        const search = await api.request('/envia_ya/person/search', { documento: payload.destinatario, type: 'receiver' });
        if (search.success && search.data && search.data.id) {
            payload.destinatario_id = search.data.id;
        } else {
            const tokens = (pedido.cliente_nombre || "Cliente Nuevo").split(' ');
            const reg = await api.request('/envia_ya/person/save', {
                documento: payload.destinatario,
                name: `${tokens[0]} ${tokens[1] || ''}`,
                firstname: tokens[2] || '',
                lastname: tokens.slice(3).join(' '),
                phone: pedido.cliente_telefono || ""
            });
            payload.destinatario_id = reg.data.id;
        }

        const result = await api.request('/envia_ya/service_order/save', payload);
        if (!result.success) throw new Error(result.message || "Error al crear orden");

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
