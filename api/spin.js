const { kv } = require('@vercel/kv');
const crypto = require('crypto');

/* =========================================================
   PREMIOS
   - "weight" = probabilidad relativa mientras haya stock (no
     tiene que sumar 100, se normaliza solo). Esto es INDEPENDIENTE
     del stock: así fones/chaveiro pueden tener buena chance real
     (para lograr repartir las 125 unidades de cada uno) sin que
     el ebook los opaque por tener stock casi ilimitado.
   - "initialStock" es la cantidad real de unidades disponibles.
     Cuando un premio llega a 0, se excluye automáticamente del
     sorteo (sus chances se reparten entre los que quedan).
   - El ebook tiene stock prácticamente ilimitado (100000): es el
     único premio digital, así que es el que "siempre" hay,
     mientras que fones, chaveiro, mentoria y licença sí se pueden
     agotar de verdad.
   ========================================================= */
const PRIZES = [
  { key: 'fones',    label: 'Fones de ouvido',                              color: '#3FB8C7', weight: 38, initialStock: 125,    instructions: 'stand' },
  { key: 'chaveiro',  label: 'Chaveiro localizador Bluetooth',               color: '#FF6B5D', weight: 38, initialStock: 125,    instructions: 'stand' },
  { key: 'mentoria',  label: '2 horas de mentoria em captação de recursos',  color: '#4CAF7D', weight: 3,  initialStock: 5,      instructions: 'stand' },
  { key: 'ebook',     label: 'Guia Prático de Doações Recorrentes',         color: '#F4B740', weight: 19, initialStock: 100000, instructions: 'link'  },
  { key: 'licenca',   label: 'Licença de 1 ano da plataforma afrus',        color: '#7A5FC4', weight: 2,  initialStock: 3,      instructions: 'stand' },
];

const EBOOK_URL = 'https://web.afrus.org/acesso/Guia-Pratico';

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

async function getCampaignVersion() {
  const v = await kv.get('campaign_version');
  return v || 1;
}

function buildPrizeList(stock) {
  return PRIZES.map((p) => ({
    label: p.label,
    color: p.color,
    stock: Number(stock[p.key] ?? 0),
    instructions: p.instructions,
    link: p.instructions === 'link' ? EBOOK_URL : null,
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
  const version = await getCampaignVersion();
  const playedKeyName = `played:v${version}:${uid}`;

  if (req.method === 'GET') {
    const playedKey = await kv.get(playedKeyName);
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
    const alreadyPlayed = await kv.get(playedKeyName);
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

    // Sorteo ponderado por "weight" fijo, filtrando solo los premios
    // que todavía tienen stock. Con reintento si hay colisión entre
    // dos personas girando en el mismo instante.
    let winnerKey = null;
    for (let attempt = 0; attempt < 5 && !winnerKey; attempt++) {
      const currentStock = await kv.hgetall('stock');
      const available = PRIZES.filter((p) => Number(currentStock[p.key] ?? 0) > 0);

      if (available.length === 0) {
        return res.status(200).json({ soldOut: true, prizes: buildPrizeList(currentStock) });
      }

      const total = available.reduce((sum, p) => sum + p.weight, 0);
      let r = Math.random() * total;
      let picked = available[available.length - 1];
      for (const p of available) {
        if (r < p.weight) { picked = p; break; }
        r -= p.weight;
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

    await kv.set(playedKeyName, winnerKey);
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
