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
      producto_handle, anticipo = 0,
      agencia_destino, agencia_id, origen, notas
    } = req.body;

    if (!cliente_nombre || !producto_handle || !agencia_destino) {
      return res.status(400).json({ error: 'Faltan: cliente_nombre, producto_handle, agencia_destino' });
    }

    // Buscar la variante (producto + color) por su handle
    const { data: producto } = await supabase
      .from('productos').select('*').eq('handle', producto_handle).single();
    if (!producto) return res.status(404).json({ error: `Producto "${producto_handle}" no encontrado` });

    // Validar stock de esa variante
    if ((producto.stock || 0) <= 0) {
      return res.status(409).json({ error: `Sin stock de ${producto.grupo || producto.nombre_corto} (${producto.color || 'Único'})` });
    }

    const precio = producto.precio_unitario;
    const ant = Number(anticipo) || 0;

    // Crear pedido (PENDIENTE)
    const { data: pedido, error } = await supabase.from('pedidos').insert({
      cliente_nombre, cliente_dni, cliente_telefono,
      producto_handle, cantidad: 1, color: producto.color,
      precio_total: precio, anticipo: ant,
      agencia_destino, agencia_id,
      estado: 'PENDIENTE', notas
    }).select().single();
    if (error) throw error;

    console.log(`[PEDIDO] #${pedido.id}: ${cliente_nombre} > ${producto.grupo || producto.nombre_corto} (${producto.color})`);

    // Crear la guía en Shalom AHORA (síncrono). El cliente paga el envío al recoger.
    const { generarEnvioShalomAPI } = require('./shalom_api_engine');
    try {
      const guia = await generarEnvioShalomAPI({ ...pedido, origen_agencia: origen }, producto);
      const envio = Number(guia.costo) || 0;
      const yape = Math.max(0, Number((precio - ant - envio).toFixed(2)));  // lo que cobro por Yape

      await supabase.from('pedidos').update({
        n_orden: guia.n_orden,
        cod_seguimiento: guia.cod_seguimiento,
        costo_envio: envio,
        saldo_cobrar: yape,
        estado: 'ENVIADO'
      }).eq('id', pedido.id);

      // Descontar 1 del stock de esa variante
      await supabase.from('productos').update({ stock: producto.stock - 1 }).eq('handle', producto_handle);

      console.log(`[BOT-OK] #${pedido.id} -> ${guia.n_orden} | envío S/${envio} | yape S/${yape} | stock ${producto.stock - 1}`);
      res.status(201).json({
        success: true, pedido_id: pedido.id, n_orden: guia.n_orden, estado: 'ENVIADO',
        precio, anticipo: ant, costo_envio: envio, a_cobrar_yape: yape,
        stock_restante: producto.stock - 1,
        message: `Guía ${guia.n_orden} creada · Yape S/${yape.toFixed(2)} (el cliente paga S/${envio} de envío al recoger)`
      });
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

// ========== STOCK / INVENTARIO (para el bot de WhatsApp del tío) ==========
// GET /api/stock?buscar=porta platos  -> disponibilidad + colores + stock, agrupado
app.get('/api/stock', async (req, res) => {
  try {
    const { buscar } = req.query;
    const { data, error } = await supabase.from('productos').select('*').eq('activo', true);
    if (error) throw error;

    const term = String(buscar || '').toLowerCase().trim();
    const match = term
      ? data.filter(p =>
          (p.grupo || '').toLowerCase().includes(term) ||
          (p.nombre || '').toLowerCase().includes(term) ||
          (p.nombre_corto || '').toLowerCase().includes(term))
      : data;

    // Agrupar por "grupo" (junta las variantes de color de un mismo producto)
    const grupos = {};
    for (const p of match) {
      const g = p.grupo || p.nombre_corto || p.nombre;
      if (!grupos[g]) {
        grupos[g] = {
          grupo: g,
          categoria: p.categoria || null,
          precio: p.precio_unitario,
          vendible: !!p.caja_shalom,   // sin caja/medidas no se puede enviar por Shalom
          colores: [],
          stock_total: 0
        };
      }
      grupos[g].colores.push({
        color: p.color || 'Único',
        stock: p.stock || 0,
        disponible: (p.stock || 0) > 0,
        sku: p.codigo,
        handle: p.handle
      });
      grupos[g].stock_total += (p.stock || 0);
    }

    const productos = Object.values(grupos).sort((a, b) => a.grupo.localeCompare(b.grupo));
    res.json({ encontrado: productos.length > 0, total: productos.length, productos });
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
