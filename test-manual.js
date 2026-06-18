const { generarEnvioShalomAPI } = require('./shalom_api_engine');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function testReal() {
    try {
        console.log('[TEST] Buscando un pedido PENDIENTE para probar...');
        
        // 1. Obtener un pedido pendiente real
        const { data: pedido, error: errP } = await supabase
            .from('pedidos')
            .select('*')
            .eq('estado', 'PENDIENTE')
            .limit(1)
            .single();

        if (errP || !pedido) {
            console.log('[TEST] No hay pedidos PENDIENTES. Creando uno de prueba...');
            // Si no hay pedidos, podrías crear uno manual aquí o usar datos quemados
            return;
        }

        // 2. Obtener el producto asociado
        const { data: producto, error: errPr } = await supabase
            .from('productos')
            .select('*')
            .eq('handle', pedido.producto_handle)
            .single();

        if (errPr || !producto) {
            console.log(`[TEST] No se encontró el producto ${pedido.producto_handle}`);
            return;
        }

        console.log(`[TEST] Probando con Pedido #${pedido.id} - Cliente: ${pedido.cliente_nombre}`);
        console.log(`[TEST] Destino: ${pedido.agencia_destino}`);

        // 3. Lanzar el bot API
        const resultado = await generarEnvioShalomAPI(pedido, producto);
        
        console.log('\n[TEST] ¡ÉXITO TOTAL!');
        console.log('[TEST] Resultado del Bot:', resultado);
        
        // 4. (Opcional) Podrías actualizarlo en la DB si quieres, pero por ahora solo testeamos
        // await supabase.from('pedidos').update({ n_orden: resultado.n_orden, estado: 'ENVIADO' }).eq('id', pedido.id);

    } catch (e) {
        console.error('\n[TEST] ❌ EL TEST FALLÓ:', e.message);
        console.log('[TEST] Revisa la carpeta "screenshots/" para ver qué pasó.');
    }
}

testReal();
