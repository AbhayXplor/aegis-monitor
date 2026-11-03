import { createService } from '../src/service.mjs';
import { createGeo } from '../src/geo.mjs';
import { SOS } from '../src/proto.mjs';

export const nowSec = () => Math.floor(Date.now() / 1000);

let tick = 0;
/** A beacon message with a strictly increasing timestamp per call. */
export const beacon = (over = {}) => ({
  device_id: 0x4b21,
  timestamp: nowSec() + tick++,
  lat: Math.round(25.2048 * 1e6),
  lon: Math.round(55.2708 * 1e6),
  altitude_m: 14,
  sos_code: SOS.TRAUMA,
  heart_rate: 118,
  spo2: 93,
  battery_pct: 43,
  duress_flag: false,
  ...over,
});

let dev = 0x5000;
export const freshDevice = () => dev++;

export function makeService(opts = {}) {
  const events = [];
  const svc = createService({
    dbPath: ':memory:',
    geo: createGeo({ env: { AEGIS_GEO: 'demo' } }),
    broadcast: (e) => events.push(e),
    env: { AEGIS_GEO: 'demo' },
    ...opts,
  });
  svc.events = events;
  return svc;
}

/** Seal and ingest a beacon in one step. */
export async function send(svc, over = {}, ingestOpts = {}) {
  const msg = beacon(over);
  const envelope = svc.sealBeacon(msg);
  return { msg, envelope, result: await svc.ingest(envelope, ingestOpts) };
}
