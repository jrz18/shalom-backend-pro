require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ws = require('ws');
const fs = require('fs');
const path = require('path');
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
      agencia_destino, agencia_id, notas,
      n_orden, cod_seguimiento
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
      n_orden: n_orden || null, cod_seguimiento: cod_seguimiento || null,
      estado: 'PENDIENTE', notas
    }).select().single();

    if (error) throw error;

    console.log(`[PEDIDO] #${pedido.id}: ${cliente_nombre} > ${producto.nombre_corto} x${cantidad}`);

    // Crear la guía en Shalom AHORA (síncrono). En Cloud Run el CPU solo está
    // garantizado durante la petición, así que NO lo dejamos en segundo plano.
    const { generarEnvioShalomAPI } = require('./shalom_api_engine');
    try {
      const guia = await generarEnvioShalomAPI(pedido, producto);
      await supabase.from('pedidos').update({
        n_orden: guia.n_orden,
        cod_seguimiento: guia.cod_seguimiento,
        estado: 'ENVIADO'
      }).eq('id', pedido.id);
      console.log(`[BOT-OK] Pedido #${pedido.id} -> ${guia.n_orden}`);
      res.status(201).json({ success: true, pedido_id: pedido.id, n_orden: guia.n_orden, estado: 'ENVIADO', message: `Guía ${guia.n_orden} creada` });
    } catch (e) {
      console.error(`[BOT-FAIL] #${pedido.id}:`, e.message);
      await supabase.from('pedidos').update({
        estado: 'ERROR',
        notas: `Error Shalom: ${e.message}`
      }).eq('id', pedido.id);
      res.status(201).json({ success: true, pedido_id: pedido.id, estado: 'ERROR', message: `Pedido guardado, pero Shalom falló: ${e.message}` });
    }
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

// ========== ELIMINAR PEDIDO ==========
app.delete('/api/pedido/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('pedidos').delete().eq('id', id);
    if (error) throw error;
    console.log(`[DELETE] Pedido ${id} eliminado`);
    res.json({ success: true });
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

// ========== AGENCIAS SHALOM (lista real de Shalom, desde agencias.json) ==========
app.get('/api/agencias', (req, res) => {
  try {
    const agencias = JSON.parse(fs.readFileSync(path.join(__dirname, 'agencias.json'), 'utf8'));
    const { buscar } = req.query;
    const result = buscar
      ? agencias.filter(a => a.nombre.toLowerCase().includes(String(buscar).toLowerCase()))
      : agencias;
    res.json({ agencias: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SYNC: Verificar estados reales desde el rastreo de Shalom ==========
app.post('/api/sync', async (req, res) => {
  try {
    // Solo los rastreables (los ENTREGADO ya no se tocan)
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('id, n_orden, cod_seguimiento, estado')
      .in('estado', ['ENVIADO', 'EN_TRANSITO', 'EN_DESTINO']);

    if (error) throw error;
    if (!pedidos || pedidos.length === 0) {
      return res.json({ message: 'No hay pedidos en tránsito para verificar', updated: 0, cambios: [] });
    }

    console.log(`[SYNC] Rastreando ${pedidos.length} pedidos...`);
    const { leerEstadosRastreo } = require('./shalom_rastreo');
    const cambios = await leerEstadosRastreo(pedidos);

    for (const c of cambios) {
      await supabase.from('pedidos').update({ estado: c.ahora }).eq('id', c.id);
      console.log(`[SYNC] ${c.n_orden}: ${c.antes} -> ${c.ahora}`);
    }

    console.log(`[SYNC] Completado. ${cambios.length} actualizados de ${pedidos.length} verificados.`);
    res.json({ message: 'Sync completado', total: pedidos.length, updated: cambios.length, cambios });
  } catch (err) {
    console.error('[SYNC ERR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
