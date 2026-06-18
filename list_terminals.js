const { shalom_api_engine } = require('./shalom_api_engine');
const fs = require('fs');
require('dotenv').config();

async function listTerminals() {
    const { generarEnvioShalomAPI } = require('./shalom_api_engine');
    // Para no disparar un envio, solo usaremos la clase
    const api = new (require('./shalom_api_engine').ShalomAPI || class{}); 
    // Re-instanciar manualmente para el test
    const ShalomAPI = require('./shalom_api_engine').ShalomAPI;
    const bot = new ShalomAPI();
    
    await bot.login();
    const res = await bot.request('/envia_ya/terminals');
    if (res.Map) {
        const names = res.Map.map(t => t.nombre);
        fs.writeFileSync('terminals.txt', names.join('\n'));
        console.log(`✅ Guardados ${names.length} terminales en terminals.txt`);
    }
}

listTerminals();
