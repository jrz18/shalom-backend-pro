// SYNC: Importar pedidos de Shalom a Supabase
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  console.log('[SYNC] Importando pedidos de Shalom a Supabase...');

  // 1. Login con Playwright
  console.log('[LOGIN] Abriendo navegador...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('https://pro.shalom.pe/login');
  await page.waitForTimeout(2000);
  await page.fill('input[name="email"]', process.env.SHALOM_USER);
  await page.fill('input[name="password"]', process.env.SHALOM_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);

  // Ir a seguimiento
  await page.goto('https://pro.shalom.pe/seguimientoenvios');
  await page.waitForTimeout(3000);
  console.log('[LOGIN] OK');

  // 2. Scrape de la tabla
  const allRows = [];

  // Obtener total de paginas
  const totalPages = await page.evaluate(() => {
    const links = document.querySelectorAll('nav a, .pagination a');
    let max = 1;
    links.forEach(a => { const n = parseInt(a.innerText); if (!isNaN(n) && n > max) max = n; });
    return max;
  }).catch(() => 1);

  console.log('[SCRAPE] Paginas detectadas:', totalPages);

  for (let p = 1; p <= totalPages; p++) {
    if (p > 1) {
      try {
        await page.click(`nav a:text-is("${p}"), .pagination a:text-is("${p}")`);
        await page.waitForTimeout(2000);
      } catch (e) {
        console.log('[SCRAPE] No se pudo navegar a pagina', p);
        break;
      }
    }

    const rows = await page.$$eval('table tbody tr', trs => {
      return trs.map(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 6) return null;
        return {
          estado: tds[0]?.innerText?.trim() || '',
          n_orden: tds[1]?.innerText?.trim().split('\n')[0]?.trim() || '',
          cod_seguimiento: (tds[1]?.innerText?.trim().split('\n')[1] || '').replace('Cod:', '').trim(),
          contenido: tds[2]?.innerText?.trim() || '',
          destinatario: tds[3]?.innerText?.trim() || '',
          monto: tds[4]?.innerText?.trim() || '',
          forma_entrega: tds[5]?.innerText?.trim() || '',
        };
      }).filter(Boolean);
    });

    console.log('[SCRAPE] Pagina ' + p + ': ' + rows.length + ' filas');
    allRows.push(...rows);
  }

  await browser.close();
  console.log('[SCRAPE] Total envios encontrados:', allRows.length);

  if (!allRows.length) {
    console.log('[ERROR] No se encontraron envios.');
    return;
  }

  // 3. Guardar en Supabase
  console.log('[SAVE] Guardando en Supabase...');
  let saved = 0, skipped = 0;

  for (const e of allRows) {
    const nOrden = e.n_orden;
    if (!nOrden) continue;

    // Verificar duplicado
    const { data: existing } = await supabase
      .from('pedidos').select('id').eq('n_orden', nOrden).limit(1);
    if (existing && existing.length > 0) {
      console.log('  SKIP: ' + nOrden + ' ya existe');
      skipped++;
      continue;
    }

    // Parsear destinatario
    const destParts = e.destinatario.split('\n');
    const clienteNombre = destParts[0]?.trim() || 'Desconocido';
    const clienteDni = (destParts[1] || '').replace('DNI:', '').replace('dni:', '').trim();

    // Parsear monto
    const montoStr = e.monto.replace('S/', '').replace('/', '').trim();
    const monto = parseFloat(montoStr) || 0;

    // Mapear estado
    let estado = 'PENDIENTE';
    const est = e.estado.toLowerCase();
    if (est.includes('destino')) estado = 'EN_TRANSITO';
    else if (est.includes('transito')) estado = 'EN_TRANSITO';
    else if (est.includes('origen')) estado = 'ENVIADO';
    else if (est.includes('entregado')) estado = 'ENTREGADO';
    else if (est.includes('recogido')) estado = 'RECOGIDO';

    const record = {
      n_orden: nOrden,
      cod_seguimiento: e.cod_seguimiento || '',
      cliente_nombre: clienteNombre,
      cliente_dni: clienteDni,
      producto_handle: 'paquete',
      cantidad: 1,
      precio_total: monto,
      saldo_cobrar: monto,
      agencia_destino: e.forma_entrega.replace('En agencia', '').replace('Terrestre', '').trim() || 'Agencia',
      estado,
      notas: 'Importado: ' + e.contenido,
    };

    const { error } = await supabase.from('pedidos').insert(record);
    if (error) {
      console.log('  ERROR: ' + nOrden + ' - ' + error.message);
    } else {
      console.log('  OK: ' + nOrden + ' - ' + clienteNombre + ' - S/' + monto + ' - ' + estado);
      saved++;
    }
  }

  console.log('\n[DONE] Guardados: ' + saved + ', Duplicados: ' + skipped);
}

main().catch(e => console.error('[FATAL]', e.message));
