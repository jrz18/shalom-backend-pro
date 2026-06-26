const { ShalomCDP } = require('./shalom_cdp_api_engine');
require('dotenv').config();

async function run() {
    const api = new ShalomCDP();
    try {
        await api.init();
        const ready = await api.refreshMetadata();
        if (!ready) {
            console.error("❌ No se pudo sincronizar la sesión. Asegúrate de estar en pro.shalom.pe logueado.");
            return;
        }

        console.log("\n--- VERIFICACIÓN INICIAL ---");
        
        // 1. Verificar person/search (DNI Damiana)
        const checkPerson = await api.request('/envia_ya/person/search', { documento: '05071045', type: 'receiver' });
        console.log("Person Search (05071045):", checkPerson.success ? "✅ OK" : "❌ FALLÓ");
        if (checkPerson.data) console.log("Nombre encontrado:", checkPerson.data.full_name || "Nuevo");

        // 2. Verificar tarifa (Cusco)
        const checkTariff = await api.request('/envia_ya/tariff/calculate', {
            origin: 411, // LOS PINOS
            destiny: "203", // SAN JERONIMO
            width: "0.30", height: "0.105", length: "0.93", weight: "6"
        });
        console.log("Tariff Calculate:", checkTariff.success ? `✅ OK (S/ ${checkTariff.data.price})` : "❌ FALLÓ");

        if (!checkPerson.success || !checkTariff.success) {
            console.log("⚠️ Verificación fallida. ¿Continuamos con los envíos reales? (Interrumpiendo para seguridad)");
            // return; // Comenta esto si quieres forzar
        }

        console.log("\n--- PROCESANDO ENVÍOS REALES ---");

        const envios = [
            {
                nombre: "Damiana Huaman Huaman",
                dni: "05071045",
                tel: "969320956",
                destino_id: 203,
                destino_nombre: "SAN JERONIMO (CUSCO)"
            },
            {
                nombre: "Hilda Picoy Lope",
                dni: "04041353",
                tel: "972393650",
                destino_id: 11,
                destino_nombre: "CERRO DE PASCO (PASCO)"
            }
        ];

        // Obtener ID de "Otra Medida"
        const prodRes = await api.request('/envia_ya/products', {}, 'POST');
        const prodOtraMedida = prodRes.data.find(p => p.title.toUpperCase().includes('OTRA MEDIDA'));
        if (!prodOtraMedida) throw new Error("No se encontró el producto 'Otra Medida'");

        for (const env of envios) {
            console.log(`\n📦 Procesando: ${env.nombre} (DNI ${env.dni})...`);
            
            // 1. Registrar/Validar Destinatario
            console.log(`Step 1: Validando destinatario ${env.dni}...`);
            const destRes = await api.request('/envia_ya/person/search', { documento: env.dni, type: 'receiver' });
            let receiverId = destRes.data ? destRes.data.id : null;
            
            if (!receiverId) {
                console.log(`Step 1b: Registrando nuevo destinatario ${env.nombre}...`);
                const tokens = env.nombre.split(' ');
                const regRes = await api.request('/envia_ya/person/save', {
                    documento: env.dni,
                    name: `${tokens[0]} ${tokens[1] || ''}`,
                    firstname: tokens[2] || '',
                    lastname: tokens.slice(3).join(' '),
                    phone: env.tel
                });
                receiverId = regRes.data.id;
            }
            console.log(`ID Destinatario: ${receiverId}`);

            // 2. Calcular Tarifa exacta
            const tariffRes = await api.request('/envia_ya/tariff/calculate', {
                origin: 411,
                destiny: String(env.destino_id),
                width: "0.30", height: "0.105", length: "0.93", weight: "6"
            });
            const costo = Number(tariffRes.data.price).toFixed(2);
            console.log(`Costo calculado: S/ ${costo}`);

            // 3. Crear Orden
            const payload = {
                origen: 411,
                destino: String(env.destino_id),
                tipo_pago: "DESTINATARIO",
                tipo_producto: prodOtraMedida.id,
                tipo_producto_json: { value: costo, name: prodOtraMedida.title, detalle: "" },
                cantidad: 1,
                peso: "6", alto: "0.105", largo: "0.93", ancho: "0.30",
                costo: costo,
                remitente: "47648778", // Del .env anterior
                destinatario: env.dni,
                remitente_id: 3386670, // Del api_engine
                destinatario_id: receiverId,
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

            console.log(`Step 3: Enviando orden final a ${env.destino_nombre}...`);
            const finalRes = await api.request('/envia_ya/service_order/save', payload);
            
            if (finalRes.success && finalRes.data) {
                console.log(`✅ ¡GUÍA CREADA! Tracking: ${finalRes.data.serie}-${finalRes.data.guia} (Cód: ${finalRes.data.codigo})`);
            } else {
                console.error(`❌ ERROR al crear guía:`, finalRes.message || "Error desconocido");
            }
        }

    } catch (err) {
        console.error("Fallo crítico:", err);
    } finally {
        await api.close();
    }
}

run();
