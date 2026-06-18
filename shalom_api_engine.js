const puppeteer = require('puppeteer-core');
require('dotenv').config();

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ===================== CONFIGURACIÓN =====================
// Remitente fijo (la cuenta que envía). Sale del .env si existe.
const REMITENTE_ID = Number(process.env.SHALOM_REMITENTE_ID || 3386670);
const REMITENTE_DNI = String(process.env.SHALOM_REMITENTE_DNI || "47648778");

// Agencia de ORIGEN fija (de dónde sale el paquete). Configurable por .env.
// Se busca por nombre contra la lista de agencias de Shalom.
const ORIGEN_AGENCIA = process.env.SHALOM_ORIGEN || "CANTO GRANDE";

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

    async login() {
        console.log("[API-ENGINE] 🔑 Iniciando sesión...");
        const browser = await puppeteer.launch({
            executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            args: ['--no-sandbox']
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
        console.log("[API-ENGINE] ✅ Sesión obtenida");
        await browser.close();
    }

    async request(path, body = {}, method = 'POST') {
        const url = `${this.baseUrl}${path}`;
        console.log(`[API-DEBUG] → ${method} ${path}`);
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Accept': 'application/json',
                'X-XSRF-TOKEN': this.xsrfToken,
                'Cookie': this.cookies,
                'x-requested-with': 'XMLHttpRequest'
            }
        };
        if (method === 'POST') options.body = JSON.stringify(body);
        const response = await fetch(url, options);
        const data = await response.json();
        console.log(`[API-DEBUG] ← ${path} [success: ${data.success}]`);
        return data;
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
                nombres: String(d.nombres).trim()
            };
        } catch (e) {
            console.log(`[API-ENGINE] ⚠️ No se pudo consultar RENIEC (DNI ${dni}): ${e.message}`);
            return null;
        }
    }

    // Registra/actualiza al destinatario y devuelve su id.
    // Usa el nombre OFICIAL por DNI (lo que Shalom valida); si no hay, cae al nombre del pedido.
    async registrarDestinatario(pedido) {
        const dni = String(pedido.cliente_dni);
        let name, firstname, lastname;

        const oficial = await this.getNombreOficial(dni);
        if (oficial && oficial.nombres) {
            // Formato que exige Shalom: name = apellidos, firstname = 1er nombre, lastname = resto
            const nombres = oficial.nombres.split(/\s+/);
            name = oficial.apellidos;
            firstname = nombres[0] || '';
            lastname = nombres.slice(1).join(' ');
            console.log(`[API-ENGINE] 🪪 Nombre oficial RENIEC: ${oficial.apellidos} ${oficial.nombres}`);
        } else {
            // Fallback: nombre tal cual vino en el pedido (texto libre, apellidos primero)
            const tokens = String(pedido.cliente_nombre || '').trim().split(/\s+/);
            if (tokens.length >= 4) { name = `${tokens[0]} ${tokens[1]}`; firstname = tokens[2]; lastname = tokens.slice(3).join(' '); }
            else if (tokens.length === 3) { name = `${tokens[0]} ${tokens[1]}`; firstname = tokens[2]; lastname = ''; }
            else { name = tokens[0] || ''; firstname = tokens[1] || ''; lastname = ''; }
            console.log(`[API-ENGINE] ⚠️ Sin dato RENIEC; uso el nombre del pedido: ${pedido.cliente_nombre}`);
        }

        console.log(`[API-ENGINE] 📝 Registrando destinatario DNI ${dni}...`);
        const res = await this.request('/envia_ya/person/save', {
            documento: dni, name, firstname, lastname,
            phone: String(pedido.cliente_telefono || "")
        });
        if (!res.success || !res.data) {
            throw new Error(`No se pudo registrar al destinatario (DNI ${dni}). ${oficial ? 'Shalom no aceptó el nombre RENIEC.' : 'No se obtuvo el nombre oficial; revisa el DNI.'} Respuesta de Shalom: ${res.message || 'sin detalle'}`);
        }
        console.log(`[API-ENGINE] ✅ Destinatario ID ${res.data.id}`);
        return res.data.id;
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
            const terminals = (await this.request('/envia_ya/terminals')).Map || [];
            const origen = this.findTerminal(terminals, ORIGEN_AGENCIA);
            if (!origen) throw new Error(`No encontré la agencia de ORIGEN "${ORIGEN_AGENCIA}"`);

            // Destino: si el pedido trae el ter_id exacto (del selector), usarlo directo.
            // Si no, buscar por nombre (texto libre).
            let destino = null;
            if (pedido.agencia_id) {
                destino = terminals.find(t => String(t.ter_id) === String(pedido.agencia_id));
            }
            if (!destino) destino = this.findTerminal(terminals, pedido.agencia_destino);
            if (!destino) throw new Error(`No encontré la agencia de DESTINO "${pedido.agencia_destino}"`);
            console.log(`[API-ENGINE] 📍 Origen ${origen.ter_id} (${origen.lugar_over}) → Destino ${destino.ter_id} (${destino.lugar_over})`);

            // 2. Destinatario
            const receiverId = await this.registrarDestinatario(pedido);

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
            console.log(`[API-ENGINE] 💰 Tarifa ${prodInfo.name}: S/ ${costo}`);

            // 6. Crear la orden
            const payload = {
                origen: origen.ter_id,
                destino: String(destino.ter_id),
                tipo_pago: "REMITENTE",
                tipo_producto: prodInfo.id,
                tipo_producto_json: { value: costo, name: prodInfo.name, detalle: esOtraMedida ? "" : prodInfo.detalle },
                cantidad: 1,
                peso: dims.peso, alto: dims.alto, largo: dims.largo, ancho: dims.ancho,
                costo: costo,
                remitente: REMITENTE_DNI,
                destinatario: String(pedido.cliente_dni),
                remitente_id: REMITENTE_ID,
                destinatario_id: receiverId,
                garantia: 0,
                garantia_costo: 0,
                garantia_monto: "0.00",
                contacto_doc: "",
                grrs: "[]",
                clave: String(process.env.SHALOM_PIN || "1812"),
                aereo: 0,
                servicio_cobranza: 0,
                servicio_cobranza_costo: 0,
                servicio_cobranza_datos: JSON.stringify({ document: "", name: "", bank: "", type_account: "", account_number: "", cci: "" }),
                declaracion_jurada: DECLARACION_JURADA
            };

            console.log("[API-ENGINE] 🚀 Creando orden de envío...");
            let result = await this.request('/envia_ya/service_order/save', payload);

            // Respaldo: si Shalom rechaza por el modo de servicio, reintentar con el otro (terrestre <-> aéreo)
            if (!result.success && /a[eé]reo|terrestre|servicio/i.test(result.message || '')) {
                payload.aereo = payload.aereo ? 0 : 1;
                console.log(`[API-ENGINE] 🔄 Modo de servicio rechazado; reintentando con aereo=${payload.aereo}...`);
                result = await this.request('/envia_ya/service_order/save', payload);
            }

            if (result.success && result.data) {
                const nOrden = `${result.data.serie}-${result.data.guia}`;
                console.log(`[API-ENGINE] 🎉 ÉXITO: Guía ${nOrden} (cód ${result.data.codigo})`);
                return {
                    n_orden: nOrden,
                    cod_seguimiento: result.data.codigo,
                    costo: Number(costo)
                };
            }

            console.log("[API-ENGINE] 📦 Respuesta:", JSON.stringify(result));
            throw new Error(result.message || "Error desconocido al crear la orden");
        } catch (err) {
            console.error("[API-ENGINE] ❌ Fallo:", err.message);
            throw err;
        }
    }
}

async function generarEnvioShalomAPI(pedido, producto) {
    const api = new ShalomAPI();
    return await api.generateOrder(pedido, producto);
}

module.exports = { generarEnvioShalomAPI, ShalomAPI };
