const { kv } = require('@vercel/kv');

/* =========================================================
   RESET DE CAMPAÑA
   - Vuelve el stock a sus valores originales.
   - Sube la "versión de campaña", lo que invalida de golpe
     todos los registros de "ya jugó" anteriores (sin tener que
     borrar miles de claves una por una).
   - Protegido con una clave secreta (variable de entorno
     ADMIN_RESET_KEY en Vercel). Sin esa clave, nadie puede
     resetear el stock desde afuera.
   - Uso: abre en el navegador
     https://TU-DOMINIO.vercel.app/api/admin-reset?key=TU_CLAVE
   ========================================================= */
const PRIZES = [
  { key: 'fones',    initialStock: 125 },
  { key: 'chaveiro',  initialStock: 125 },
  { key: 'mentoria',  initialStock: 5   },
  { key: 'ebook',     initialStock: 100000 },
  { key: 'licenca',   initialStock: 3   },
];

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providedKey = req.query.key || (req.headers['x-admin-key']);
  const expectedKey = process.env.ADMIN_RESET_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      error: 'Falta configurar la variable de entorno ADMIN_RESET_KEY en Vercel.',
    });
  }

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: 'Clave inválida o faltante.' });
  }

  const seed = {};
  PRIZES.forEach((p) => { seed[p.key] = p.initialStock; });
  await kv.hset('stock', seed);

  const currentVersion = (await kv.get('campaign_version')) || 1;
  const newVersion = Number(currentVersion) + 1;
  await kv.set('campaign_version', newVersion);

  return res.status(200).json({
    ok: true,
    message: 'Stock reiniciado y todos los registros de "ya jugó" fueron invalidados.',
    stock: seed,
    campaignVersion: newVersion,
  });
};
