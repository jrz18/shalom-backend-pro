require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ws = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());

// Iniciar servidor de inmediato (Cloud Run necesita esto)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Shalom Backend Pro corriendo en puerto ${PORT}`);
});

// ========== SUPABASE ==========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { realtime: { transport: ws } }
);

const API_KEY = process.env.API_KEY;

// ========== AUTH MIDDLEWARE ==========
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({ status: 'online', servicio: 'Shalom Backend Pro v1.0' });
});

// ========== REGISTRAR PEDIDO ==========
app.post('/api/pedido', auth, async (req, res) => {
  try {
    const {
      cliente_nombre, cliente_dni, cliente_telefono,
      producto_handle, cantidad = 1,
      precio_total, saldo_cobrar,
      agencia_destino, agencia_id, notas
    } = req.body;

    if (!cliente_nombre || !producto_handle || !agencia_destino) {
      return res.status(400).json({ error: 'Faltan: cliente_nombre, producto_handle, agencia_destino' });
    }

    // Buscar producto
    const { data: producto } = await supabase
      .from('productos').select('*').eq('handle', producto_handle).single();

    if (!producto) return res.status(404).json({ error: `Producto "${producto_handle}" no encontrado` });

    const total = precio_total || (producto.precio_unitario * cantidad);
    const saldo = saldo_cobrar ?? total;

    const { data: pedido, error } = await supabase.from('pedidos').insert({
      cliente_nombre, cliente_dni, cliente_telefono,
      producto_handle, cantidad,
      precio_total: total, saldo_cobrar: saldo,
      agencia_destino, agencia_id,
      estado: 'PENDIENTE', notas
    }).select().single();

    if (error) throw error;

    console.log(`[PEDIDO] #${pedido.id}: ${cliente_nombre} > ${producto.nombre_corto} x${cantidad}`);
    res.status(201).json({ success: true, pedido_id: pedido.id, pedido });
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== LISTAR TODOS LOS PEDIDOS (HISTORIAL) ==========
app.get('/api/pedidos', async (req, res) => {
  try {
    const { estado, limit = 100 } = req.query;

    let query = supabase.from('pedidos').select('*, productos(*)').order('n_orden', { ascending: false }).limit(limit);

    if (estado && estado !== 'TODOS') {
      query = query.eq('estado', estado);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Contar por estado
    const stats = {
      PENDIENTE: 0, ENVIADO: 0, EN_TRANSITO: 0, ENTREGADO: 0, RECOGIDO: 0, ERROR: 0
    };
    data.forEach(p => { if (stats[p.estado] !== undefined) stats[p.estado]++; });

    res.json({ total: data.length, stats, pedidos: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ACTUALIZAR ESTADO DE PEDIDO ==========
app.patch('/api/pedido/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('pedidos').update(updates).eq('id', id).select().single();

    if (error) throw error;
    res.json({ success: true, pedido: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CATALOGO DE PRODUCTOS ==========
app.get('/api/productos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('productos').select('*').eq('activo', true).order('nombre_corto');
    if (error) throw error;
    res.json({ total: data.length, productos: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== AGENCIAS SHALOM ==========
app.get('/api/agencias', async (req, res) => {
  try {
    const { buscar } = req.query;
    let query = supabase.from('agencias').select('*').order('distrito');

    if (buscar) {
      query = query.ilike('distrito', `%${buscar}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ agencias: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SYNC: Verificar estados reales desde shalom.com.pe ==========
app.post('/api/sync', async (req, res) => {
  const puppeteer = require('puppeteer-core');
  let browser;
  
  try {
    // Buscar pedidos que NO estan entregados
    const { data: pendientes, error } = await supabase
      .from('pedidos')
      .select('id, n_orden, cod_seguimiento, estado')
      .neq('estado', 'ENTREGADO');

    if (error) throw error;
    if (!pendientes || pendientes.length === 0) {
      return res.json({ message: 'Todos los pedidos ya estan entregados', updated: 0 });
    }

    console.log(`[SYNC] Verificando ${pendientes.length} pedidos...`);

    browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    let updated = 0;
    const results = [];

    for (const pedido of pendientes) {
      try {
        // Ir a la pagina de rastreo publico
        await page.goto(`https://shalom.com.pe/rastrea`, { waitUntil: 'networkidle2', timeout: 15000 });
        await page.waitForTimeout(2000);

        // Llenar N° de Orden
        const inputs = await page.$$('input');
        if (inputs.length >= 2) {
          await inputs[0].click({ clickCount: 3 });
          await inputs[0].type(pedido.n_orden);
          await inputs[1].click({ clickCount: 3 });
          await inputs[1].type(pedido.cod_seguimiento);
        }

        // Click Buscar
        const buscarBtn = await page.$('button.btn-search, button[type="submit"], .btn-buscar');
        if (buscarBtn) await buscarBtn.click();
        else {
          const buttons = await page.$$('button');
          for (const btn of buttons) {
            const text = await btn.evaluate(el => el.textContent);
            if (text.includes('Buscar')) { await btn.click(); break; }
          }
        }

        await page.waitForTimeout(4000);

        // Leer el estado del texto grande
        const pageText = await page.evaluate(() => document.body.innerText);
        
        let realStatus = null;
        if (pageText.includes('Entregado')) realStatus = 'ENTREGADO';
        else if (pageText.includes('En destino')) realStatus = 'EN_DESTINO';
        else if (pageText.includes('En tránsito') || pageText.includes('En transito')) realStatus = 'EN_TRANSITO';
        else if (pageText.includes('En origen')) realStatus = 'ENVIADO';

        if (realStatus && realStatus !== pedido.estado) {
          await supabase.from('pedidos').update({ estado: realStatus }).eq('id', pedido.id);
          console.log(`[SYNC] ${pedido.n_orden}: ${pedido.estado} -> ${realStatus}`);
          updated++;
          results.push({ orden: pedido.n_orden, antes: pedido.estado, ahora: realStatus });
        } else {
          results.push({ orden: pedido.n_orden, estado: pedido.estado, cambio: false });
        }
      } catch (err) {
        console.log(`[SYNC ERR] ${pedido.n_orden}: ${err.message}`);
        results.push({ orden: pedido.n_orden, error: err.message });
      }
    }

    await browser.close();
    console.log(`[SYNC] Completado. ${updated} actualizados.`);
    res.json({ message: `Sync completado`, total: pendientes.length, updated, results });
  } catch (err) {
    if (browser) await browser.close();
    console.error('[SYNC ERR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
