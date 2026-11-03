// Store-and-forward mesh (BLE / LoRa) simulation.
//
// A wristband under rubble or indoors has no line of sight to a satellite. It hands the
// still-encrypted packet to neighbours; each hop is a transfer between nodes, bounded by
// MESH_MAX_HOPS. If no reachable node has sky visibility the packet is STORED at the
// nodes holding it and delivered later, when a node regains sky or a new link appears.
//
// The ciphertext is never re-encrypted or modified in transit; only transport metadata
// (hop count, path) is added. Duplicates are expected (several paths, several gateways)
// and the ingest side suppresses them by envelope id.
//
// STATUS: simulation of the routing behaviour. No BLE or LoRa driver, no collision
// handling, no duty-cycle accounting.

import { envelopeId } from './crypto.mjs';

export const MESH_MAX_HOPS = 3;

export class MeshNetwork {
  /** @param {{ uplink: (envelope: Buffer, meta: {hops:number, path:string[], packet_id:string, stored:boolean}) => void, maxHops?: number }} opts */
  constructor({ uplink, maxHops = MESH_MAX_HOPS }) {
    this.uplink = uplink;
    this.maxHops = maxHops;
    this.nodes = new Map(); // id -> { sky }
    this.links = new Map(); // id -> Set(id)
    this.pending = new Map(); // packet_id -> { envelope, holders: Map(nodeId -> {hops, path}) }
  }

  addNode(id, { sky = false } = {}) {
    this.nodes.set(id, { sky });
    if (!this.links.has(id)) this.links.set(id, new Set());
    return this;
  }

  link(a, b) {
    this.links.get(a).add(b);
    this.links.get(b).add(a);
    this.retry();
    return this;
  }

  unlink(a, b) {
    this.links.get(a)?.delete(b);
    this.links.get(b)?.delete(a);
    return this;
  }

  /** Give or remove sky visibility. Gaining it flushes everything that can now reach it. */
  setSky(id, sky) {
    this.nodes.get(id).sky = !!sky;
    return sky ? this.retry() : [];
  }

  /** Shortest path (<= budget transfers) from `start` to any sky node. */
  _route(start, budget) {
    const seen = new Set([start]);
    let frontier = [[start]];
    for (let depth = 0; depth <= budget; depth++) {
      const next = [];
      for (const path of frontier) {
        const node = path[path.length - 1];
        if (this.nodes.get(node).sky) return path;
        if (depth === budget) continue;
        for (const nb of [...this.links.get(node)].sort()) {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push([...path, nb]);
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  _deliver(packetId, path, stored) {
    const entry = this.pending.get(packetId);
    this.pending.delete(packetId);
    this.uplink(entry.envelope, { hops: path.length - 1, path, packet_id: packetId, stored });
    return { packet_id: packetId, hops: path.length - 1, path };
  }

  /** Originate a packet at `from`. */
  send(envelope, from) {
    if (!this.nodes.has(from)) throw new Error('unknown node ' + from);
    const packet_id = envelopeId(envelope);
    this.pending.set(packet_id, { envelope, holders: new Map([[from, { hops: 0, path: [from] }]]) });
    const path = this._route(from, this.maxHops);
    if (path) return { delivered: true, stored: false, ...this._deliver(packet_id, path, false) };

    // No sky within reach: replicate to every node reachable inside the hop budget.
    const holders = this.pending.get(packet_id).holders;
    let frontier = [[from]];
    const seen = new Set([from]);
    for (let d = 1; d <= this.maxHops; d++) {
      const next = [];
      for (const p of frontier) {
        for (const nb of [...this.links.get(p[p.length - 1])].sort()) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const np = [...p, nb];
          holders.set(nb, { hops: d, path: np });
          next.push(np);
        }
      }
      frontier = next;
    }
    return { delivered: false, stored: true, packet_id, stored_at: [...holders.keys()], reason: 'no node with sky visibility within hop limit' };
  }

  /** Re-attempt every stored packet from every node holding it. */
  retry() {
    const delivered = [];
    for (const [packetId, entry] of [...this.pending]) {
      let best = null;
      for (const [holder, info] of entry.holders) {
        const route = this._route(holder, this.maxHops - info.hops);
        if (route) {
          const full = [...info.path.slice(0, -1), ...route];
          if (!best || full.length < best.length) best = full;
        }
      }
      if (best) delivered.push(this._deliver(packetId, best, true));
    }
    return delivered;
  }

  pendingPackets() {
    return [...this.pending].map(([id, e]) => ({ packet_id: id, stored_at: [...e.holders.keys()] }));
  }
}
