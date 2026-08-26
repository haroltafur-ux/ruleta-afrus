const { kv } = require('@vercel/kv');
const crypto = require('crypto');

/* =========================================================
   PREMIOS Y STOCK INICIAL
   - "initialStock" es la cantidad real de unidades disponibles.
   - La probabilidad de cada premio = su stock restante / stock
     total restante. No hace falta configurar pesos a mano: si
     un premio tiene poco stock, sale poco. Si se agota, deja de
     poder salir.
   - Para cambiar el stock inicial de una campaña nueva, edita
     estos números y borra la clave "stock" en Vercel KV (o usa
     una key distinta) para que se vuelva a inicializar.
   ========================================================= */
const PRIZES = [
  { key: 'fones',    label: 'Fones de ouvido',                              color: '#3FB8C7', initialStock: 125 },
  { key: 'chaveiro',  label: 'Chaveiro localizador Bluetooth',               color: '#FF6B5D', initialStock: 125 },
  { key: 'mentoria',  label: '2 horas de mentoria em captação de recursos',  color: '#4CAF7D', initialStock: 5   },
  { key: 'ebook',     label: 'Ebook de captação',                           color: '#F4B740', initialStock: 125 },
  { key: 'licenca',   label: 'Licença de 1 ano da plataforma afrus',        color: '#7A5FC4', initialStock: 3   },
];

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').filter(Boolean).map((c) => {
      const idx = c.indexOf('=');
      const k = c.slice(0, idx).trim();
      const v = c.slice(idx + 1).trim();
      return [k, decodeURIComponent(v)];
    })
  );
}

async function ensureStock() {
  const existing = await kv.hgetall('stock');
  if (!existing || Object.keys(existing).length === 0) {
    const seed = {};
    PRIZES.forEach((p) => { seed[p.key] = p.initialStock; });
    await kv.hset('stock', seed);
    return seed;
  }
  return existing;
}

function buildPrizeList(stock) {
  return PRIZES.map((p) => ({
    label: p.label,
    color: p.color,
    stock: Number(stock[p.key] ?? 0),
  }));
}

module.exports = async (req, res) => {
  const cookies = parseCookies(req);
  let uid = cookies.wheel_uid;
  const isNewVisitor = !uid;
  if (isNewVisitor) uid = crypto.randomUUID();

  if (isNewVisitor) {
    res.setHeader('Set-Cookie', `wheel_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }

  const stock = await ensureStock();

  if (req.method === 'GET') {
    const playedKey = await kv.get(`played:${uid}`);
    if (playedKey) {
      const prizeDef = PRIZES.find((p) => p.key === playedKey);
      return res.status(200).json({
        played: true,
        prizeIndex: PRIZES.findIndex((p) => p.key === playedKey),
        prizeLabel: prizeDef ? prizeDef.label : playedKey,
        prizes: buildPrizeList(stock),
      });
    }
    return res.status(200).json({ played: false, prizes: buildPrizeList(stock) });
  }

  if (req.method === 'POST') {
    const alreadyPlayed = await kv.get(`played:${uid}`);
    if (alreadyPlayed) {
      const prizeDef = PRIZES.find((p) => p.key === alreadyPlayed);
      const currentStock = await kv.hgetall('stock');
      return res.status(200).json({
        played: true,
        prizeIndex: PRIZES.findIndex((p) => p.key === alreadyPlayed),
        prizeLabel: prizeDef ? prizeDef.label : alreadyPlayed,
        prizes: buildPrizeList(currentStock),
      });
    }

    // Sorteo ponderado por stock restante, con reintento si hay colisión
    // entre dos personas girando en el mismo instante.
    let winnerKey = null;
    for (let attempt = 0; attempt < 5 && !winnerKey; attempt++) {
      const currentStock = await kv.hgetall('stock');
      const available = PRIZES.filter((p) => Number(currentStock[p.key] ?? 0) > 0);

      if (available.length === 0) {
        return res.status(200).json({ soldOut: true, prizes: buildPrizeList(currentStock) });
      }

      const total = available.reduce((sum, p) => sum + Number(currentStock[p.key]), 0);
      let r = Math.random() * total;
      let picked = available[available.length - 1];
      for (const p of available) {
        const w = Number(currentStock[p.key]);
        if (r < w) { picked = p; break; }
        r -= w;
      }

      const newVal = await kv.hincrby('stock', picked.key, -1);
      if (newVal < 0) {
        await kv.hincrby('stock', picked.key, 1); // revertir, alguien se adelantó
        continue;
      }
      winnerKey = picked.key;
    }

    if (!winnerKey) {
      const currentStock = await kv.hgetall('stock');
      return res.status(200).json({ soldOut: true, prizes: buildPrizeList(currentStock) });
    }

    await kv.set(`played:${uid}`, winnerKey);
    const finalStock = await kv.hgetall('stock');
    const prizeDef = PRIZES.find((p) => p.key === winnerKey);

    return res.status(200).json({
      played: true,
      justWon: true,
      prizeIndex: PRIZES.findIndex((p) => p.key === winnerKey),
      prizeLabel: prizeDef.label,
      prizes: buildPrizeList(finalStock),
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
