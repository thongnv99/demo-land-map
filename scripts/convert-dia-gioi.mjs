// Chuyển shapefile địa giới hành chính VN2000 / UTM 48N -> GeoJSON WGS84
// Input : data/dia-gioi-hanh-chinh/Ranh_GioiVN2000.shp
// Output: data/dia-gioi.geojson
// Chạy: node scripts/convert-dia-gioi.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';

const ROOT = new URL('..', import.meta.url);
const SRC = new URL('data/dia-gioi-hanh-chinh/Ranh_GioiVN2000', ROOT);

// VN-2000 / UTM zone 48N (EPSG:3405) + 7 tham số chuyển đổi sang WGS84 (QĐ 05/2007/QĐ-BTNMT)
const VN2000_UTM48 =
  '+proj=utm +zone=48 +ellps=WGS84 +units=m +no_defs ' +
  '+towgs84=-191.90441429,-39.30318279,-111.45032835,-0.00928836,0.01975479,-0.00427372,0.252906278';
const toWgs84 = proj4(VN2000_UTM48, 'EPSG:4326');

const round = (n) => Math.round(n * 1e6) / 1e6;
const project = (coords) => coords.map((c) => toWgs84.forward(c).map(round));

const LOAI = {
  AA01: 'quoc-gia',
  AC01: 'tinh',
  AC02: 'huyen',
  BA010: 'duong-bo',
};

const source = await shapefile.open(fileURLToPath(`${SRC}.shp`), fileURLToPath(`${SRC}.dbf`), { encoding: 'utf-8' });
const features = [];
for (let r = await source.read(); !r.done; r = await source.read()) {
  const { properties: p, geometry: g } = r.value;
  const coordinates = g.type === 'LineString' ? project(g.coordinates) : g.coordinates.map(project);
  features.push({ type: 'Feature', properties: { ma: p.Ma, loai: LOAI[p.Ma] || p.Loai }, geometry: { type: g.type, coordinates } });
}

const out = new URL('data/dia-gioi.geojson', ROOT);
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }));
const count = features.reduce((m, f) => ((m[f.properties.loai] = (m[f.properties.loai] || 0) + 1), m), {});
console.log('dia-gioi.geojson:', features.length, 'features', count, (fs.statSync(out).size / 1e6).toFixed(1) + ' MB');
