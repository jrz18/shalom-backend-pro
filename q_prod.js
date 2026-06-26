require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
(async () => {
  const { data, error } = await supabase.from('productos').select('*').ilike('grupo', '%porta%plato%');
  if (error) { console.error(error.message); process.exit(1); }
  for (const p of data) {
    console.log(JSON.stringify({
      handle: p.handle, grupo: p.grupo, color: p.color, caja_shalom: p.caja_shalom,
      precio: p.precio_unitario, stock: p.stock, categoria: p.categoria,
      ancho_cm: p.ancho_cm, alto_cm: p.alto_cm, prof_cm: p.prof_cm, peso_kg: p.peso_kg
    }));
  }
})();
