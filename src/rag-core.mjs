// Embedded vector store, pure JS, no Node-only imports (the offline field app
// loads this same file in the browser).
//
// Embedding: signed feature hashing of unigrams + bigrams into DIM dimensions,
// sublinear TF x corpus IDF, L2-normalised. Retrieval: cosine similarity, ties
// broken by id so results are fully deterministic.
//
// HONEST LIMIT: this is a lexical embedding, not a semantic one. It matches shared
// vocabulary, which is why every KB chunk carries a `keywords` field. A dense
// embedder (e.g. an Ollama embedding model) can replace `embed` without changing
// the store interface.

export const DIM = 512;

const STOP = new Set(('a an the and or of to in on at for with without is are was be been it its this that these those ' +
  'as by from if then than so do does not no you your i we they he she them his her their can will should must may ' +
  'any all each per via into out up down over under before after during until while when where which who whom how').split(' '));

export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.filter((w) => !STOP.has(w) && w.length > 1).map(stem);
}

function fnv(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function features(text) {
  const t = tokenize(text);
  const f = new Map();
  const bump = (k) => f.set(k, (f.get(k) || 0) + 1);
  for (let i = 0; i < t.length; i++) {
    bump(t[i]);
    if (i + 1 < t.length) bump(t[i] + '_' + t[i + 1]);
  }
  return f;
}

function embedWith(text, idf) {
  const v = new Float32Array(DIM);
  for (const [k, tf] of features(text)) {
    const h = fnv(k);
    const sign = fnv(k, 0x9e3779b1) & 1 ? 1 : -1;
    v[h % DIM] += sign * (1 + Math.log(tf)) * (idf.get(k) ?? 1);
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
};

export class VectorStore {
  constructor() {
    this.docs = [];
    this.vecs = [];
    this.terms = [];
    this.idf = new Map();
  }

  /** Build the index from docs [{ id, text, ...meta }]. IDF is corpus-wide. */
  build(docs) {
    this.docs = docs.slice();
    const df = new Map();
    for (const d of this.docs) for (const k of features(d.text).keys()) df.set(k, (df.get(k) || 0) + 1);
    const n = this.docs.length;
    this.idf = new Map([...df].map(([k, c]) => [k, Math.log(1 + n / c)]));
    this.vecs = this.docs.map((d) => embedWith(d.text, this.idf));
    this.terms = this.docs.map((d) => new Set(tokenize(d.text)));
    return this;
  }

  size() {
    return this.docs.length;
  }

  /**
   * Top-k by cosine similarity, deterministic: score desc, then id asc.
   * A document is only eligible if it shares at least one real term with the query.
   * Feature hashing maps unrelated words onto the same dimension, so without this gate
   * a query of pure gibberish still "matches" something and the honest no-result answer
   * can never fire.
   */
  query(text, k = 3, { minScore = 0.05 } = {}) {
    const q = embedWith(text, this.idf);
    const qTerms = [...new Set(tokenize(text))];
    return this.docs
      .map((doc, i) => ({ doc, score: dot(q, this.vecs[i]), shared: qTerms.some((t) => this.terms[i].has(t)) }))
      .filter((r) => r.shared && r.score >= minScore)
      .sort((a, b) => b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1))
      .slice(0, k)
      .map(({ doc, score }) => ({ doc, score: +score.toFixed(4) }));
  }
}
