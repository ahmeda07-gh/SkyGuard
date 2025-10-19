// server.js
console.log('Starting SkyGuard backend…');
process.on('uncaughtException', err => console.error('Uncaught:', err));
process.on('unhandledRejection', err => console.error('Unhandled:', err));

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3002;
const app = express();

/* ====================== deps & helpers ====================== */
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const cache = { flights: { t: 0, data: [] }, metar: new Map() };
const US_BBOX = { minLon: -130, maxLon: -60, minLat: 20, maxLat: 55 };

function inUS(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
         lat >= US_BBOX.minLat && lat <= US_BBOX.maxLat &&
         lon >= US_BBOX.minLon && lon <= US_BBOX.maxLon;
}

// quick simulator (fallback when real feed is empty)
function generateSimulatedFlights(n = 120) {
  const airlines = ["AA","DL","UA","AS","WN","B6","NK","F9","HA","G4"];
  const rand = (a,b)=>Math.random()*(b-a)+a;
  const boxes=[[-125,24.5,-66.9,49.5],[-170,51,-129,71],[-161,18.8,-154,22.4]];
  const inBoxes=(lat,lon)=>boxes.some(([lmin,bmin,lmax,bmax])=> lon>=lmin&&lon<=lmax&&lat>=bmin&&lat<=bmax );

  const arr=[];
  for(let i=0;i<n;i++){
    let lat,lon; do{ lat=rand(25,49); lon=rand(-124,-67);} while(!inBoxes(lat,lon));
    const a = airlines[Math.floor(Math.random()*airlines.length)];
    arr.push({
      id:`SIM${i.toString().padStart(3,'0')}`, airline:a, lat, lon,
      alt_ft: rand(26000,38000), vel_kt: rand(380,480), hdg: rand(0,360),
      origin:'KSEA', dest:'KSFO'
    });
  }
  return arr;
}
/* =========================================================== */

// ---- middleware ----
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// serve index.html and assets from this folder
const PUBLIC_DIR = __dirname; // index.html is here
app.use(express.static(PUBLIC_DIR));

// ---- storage setup ----
const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR);
const LOG_FILE = path.join(DATA_DIR, 'logs.json');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]', 'utf-8');

// uploads (multer)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UP_DIR),
  filename: (_req, file, cb) => {
    const id = nanoid(10);
    const ext = path.extname(file.originalname || '').slice(0, 8);
    cb(null, `${Date.now()}_${id}${ext}`);
  }
});
const upload = multer({ storage });

// helper to append to JSON log
function appendJson(filePath, item) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const arr = JSON.parse(raw || '[]');
  arr.push(item);
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf-8');
  return item;
}

// ---- API routes ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error: 'No file provided' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url: fileUrl, filename: req.file.filename });
});

app.use('/uploads', express.static(UP_DIR));

app.post('/api/logs', (req, res) => {
  const item = {
    id: nanoid(8),
    t: Date.now(),
    type: req.body.type || 'event',
    payload: req.body.payload || {},
    meta: req.body.meta || {}
  };
  appendJson(LOG_FILE, item);
  res.json({ ok: true, id: item.id });
});

app.get('/api/logs', (_req, res) => {
  const raw = fs.readFileSync(LOG_FILE, 'utf-8');
  const arr = JSON.parse(raw || '[]').sort((a,b)=>b.t-a.t);
  res.json({ ok: true, items: arr.slice(0, 200) });
});

/* ====================== real-data endpoints ====================== */

// GET /api/flights — public ADS-B feed (fallback to sim if empty)
app.get('/api/flights', async (_req, res) => {
  try {
    const now = Date.now();
    if (now - cache.flights.t < 10_000 && cache.flights.data.length) {
      return res.json({ flights: cache.flights.data, source: 'cache' });
    }

    let mapped = [];
    try {
      const r = await fetch('https://api.adsb.lol/v2/state/all', { timeout: 8000 });
      if (r.ok) {
        const data = await r.json();
        mapped = (data.states || [])
          .filter(sv => inUS(sv.lat, sv.lon))
          .slice(0, 150)
          .map((sv, i) => ({
            id: sv.hex || sv.icao24 || `ADSB${i}`,
            airline: (sv.callsign || 'UA  ').trim().slice(0, 2) || 'UA',
            lat: sv.lat,
            lon: sv.lon,
            alt_ft: Number.isFinite(sv.baro_altitude) ? sv.baro_altitude * 3.28084 : 0,
            vel_kt: Number.isFinite(sv.velocity) ? sv.velocity * 1.94384 : 0,
            hdg: Number.isFinite(sv.heading) ? sv.heading : 0,
            origin: 'KSEA',
            dest: 'KSFO'
          }));
      } else {
        console.warn('ADS-B HTTP', r.status);
      }
    } catch (e) {
      console.warn('ADS-B fetch error:', e.message);
    }

    if (!mapped.length) {
      mapped = generateSimulatedFlights();
      cache.flights = { t: now, data: mapped };
      return res.json({ flights: mapped, source: 'simulated' });
    }

    cache.flights = { t: now, data: mapped };
    res.json({ flights: mapped, source: 'adsb-exchange' });
  } catch (e) {
    console.error('flights fatal', e.message);
    res.status(200).json({ flights: generateSimulatedFlights(80), source: 'simulated' });
  }
});

// GET /api/metar?icao=KSEA — NOAA text METAR (no auth required)
app.get('/api/metar', async (req, res) => {
  try {
    const icao = (req.query.icao || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if (!icao || icao.length < 4) return res.status(400).json({ error: 'Bad ICAO' });

    const key = `metar:${icao}`;
    const now = Date.now();
    const cached = cache.metar.get(key);
    if (cached && now - cached.t < 120_000) {
      return res.json(cached.data);
    }

    const url = `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) throw new Error(`NOAA ${r.status}`);
    const txt = await r.text();
    const lines = txt.trim().split('\n');
    const metar = lines[lines.length - 1] || '';

    const out = { icao, metar, fetchedAt: new Date().toISOString() };
    cache.metar.set(key, { t: now, data: out });
    res.json(out);
  } catch (e) {
    console.error('metar error', e.message);
    res.status(200).json({ icao: (req.query.icao || '').toUpperCase(), metar: '', fetchedAt: new Date().toISOString() });
  }
});
/* ================================================================ */

// serve index.html for any non-API route
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- start server ----
app.listen(PORT, () => {
  console.log(`✅ SkyGuard backend listening on http://localhost:${PORT}`);
}).on('error', (e) => {
  console.error('❌ Server error:', e);
});
