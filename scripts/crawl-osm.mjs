// Crawl OSM (Overpass) cho ranh giới phường trong 00190.geojson
// -> data/parcels.geojson  : thửa đất (proxy = building footprint OSM)
// -> data/planning.geojson : lớp quy hoạch sử dụng đất (proxy = landuse/amenity OSM, gán mã đất VN)
// -> data/roads.geojson    : trục đường chính (dùng để dựng chỉ giới đường đỏ ở client)
// Chạy: node scripts/crawl-osm.mjs
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const ward = JSON.parse(fs.readFileSync(new URL('00190.geojson', ROOT)));
const wardRings = ward.features[0].geometry.coordinates.map((poly) => poly[0]);

const pts = wardRings.flat();
const lngs = pts.map((p) => p[0]);
const lats = pts.map((p) => p[1]);
const bbox = [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)].join(',');

const query = `
[out:json][timeout:120];
(
  way["building"](${bbox});
  way["landuse"](${bbox});
  way["leisure"~"park|garden|pitch|playground"](${bbox});
  way["amenity"~"school|university|college|kindergarten|hospital|clinic|place_of_worship|marketplace"](${bbox});
  way["natural"="water"](${bbox});
  way["highway"~"^(primary|secondary|tertiary|trunk)$"](${bbox});
);
out geom tags;`;

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass() {
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'demo-land-map-poc' },
      });
      if (res.ok) return res.json();
      console.warn(url, res.status);
    } catch (e) {
      console.warn(url, e.message);
    }
  }
  throw new Error('Overpass failed');
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inWard = (p) => wardRings.some((r) => pointInRing(p, r));
const centroid = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];

// Diện tích xấp xỉ (m²) theo phép chiếu equirectangular - đủ cho demo
function areaM2(ring) {
  const lat0 = (ring[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
  }
  return Math.abs(a / 2);
}

// Map tag OSM -> mã loại đất quy hoạch (theo ký hiệu phổ biến trong đồ án QH VN)
function landCode(t) {
  if (t.amenity && /school|university|college|kindergarten/.test(t.amenity)) return 'GD';
  if (t.amenity && /hospital|clinic/.test(t.amenity)) return 'YT';
  if (t.amenity === 'place_of_worship' || t.landuse === 'religious') return 'TON';
  if (t.amenity === 'marketplace' || /retail|commercial/.test(t.landuse || '')) return 'TMDV';
  if (t.leisure || /grass|recreation_ground|village_green/.test(t.landuse || '')) return 'CX';
  if (t.natural === 'water' || /basin|reservoir/.test(t.landuse || '')) return 'MN';
  if (t.landuse === 'residential') return 'ODT';
  if (/industrial/.test(t.landuse || '')) return 'CN';
  if (/military/.test(t.landuse || '')) return 'QP';
  if (t.landuse === 'construction') return 'HH';
  return null;
}

const ringOf = (el) => {
  const ring = el.geometry.map((g) => [+g.lon.toFixed(7), +g.lat.toFixed(7)]);
  const [a, b] = [ring[0], ring[ring.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
  return ring;
};

const data = await overpass();
const parcels = [];
const planning = [];
const roads = [];
let seq = 0;

for (const el of data.elements) {
  if (el.type !== 'way' || !el.geometry) continue;
  const t = el.tags || {};

  if (t.highway) {
    const line = el.geometry.map((g) => [g.lon, g.lat]);
    if (line.some(inWard)) {
      roads.push({ type: 'Feature', properties: { osm_id: el.id, name: t.name || '', highway: t.highway, width: +(t.width || 0) }, geometry: { type: 'LineString', coordinates: line } });
    }
    continue;
  }

  if (el.geometry.length < 4) continue;
  const ring = ringOf(el);
  if (!inWard(centroid(ring))) continue;

  if (t.building) {
    seq++;
    parcels.push({
      type: 'Feature',
      properties: {
        id: `OCD-${String(seq).padStart(5, '0')}`,
        so_to: 10 + Math.floor(seq / 150), // tờ bản đồ giả lập
        so_thua: seq,
        dia_chi: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || '',
        dien_tich: Math.round(areaM2(ring) * 10) / 10,
        osm_id: el.id,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
    continue;
  }

  const code = landCode(t);
  if (code) {
    planning.push({ type: 'Feature', properties: { code, name: t.name || '', osm_id: el.id }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
}

fs.mkdirSync(new URL('data/', ROOT), { recursive: true });
const write = (name, features) => {
  fs.writeFileSync(new URL(`data/${name}`, ROOT), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`${name}: ${features.length} features`);
};
write('parcels.geojson', parcels);
write('planning.geojson', planning);
write('roads.geojson', roads);
