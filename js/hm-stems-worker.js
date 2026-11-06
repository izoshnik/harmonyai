/* ============================================================================
   РАЗБОР ТРЕКА НА ПАРТИИ — фоновый поток (module worker).
   Нейросеть HTDemucs (Meta, лицензия MIT) в формате ONNX работает прямо в
   браузере: WebGPU, если он есть, иначе WebAssembly. Сервер и ключи не нужны.
   Делит трек на 4 партии: ударные, бас, «остальное», вокал — и сразу собирает
   из них только то, что нужно пользователю (так в памяти телефона лежит одна
   дорожка, а не четыре).

   main → worker: {type:'run', left, right, keep:[ударные,бас,остальное,вокал]}
   worker → main: {type:'download', loaded, total} | {type:'stage', stage}
                  {type:'progress', p} | {type:'done', wav} | {type:'error', message}
   Модель (~180 МБ) скачивается один раз и лежит в Cache Storage.
   ========================================================================== */
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs';
import { prepareModelInput, standaloneMask, standaloneIspec, CONSTANTS } from 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/src/index.js';

const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const MODEL_CACHE = 'hm-stems-model-v1';
const { TRAINING_SAMPLES, SEGMENT_OVERLAP, SAMPLE_RATE } = CONSTANTS;

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
// Без cross-origin isolation многопоточный WebAssembly недоступен — один поток.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let session = null;
let backend = '';

const post = (m, transfer) => self.postMessage(m, transfer || []);

async function cachedModel() {
  try {
    const c = await caches.open(MODEL_CACHE);
    const hit = await c.match(MODEL_URL);
    if (hit) return await hit.arrayBuffer();
  } catch (e) { /* Cache Storage недоступен — качаем без кэша */ }
  return null;
}

async function downloadModel() {
  const r = await fetch(MODEL_URL);
  if (!r.ok || !r.body) throw new Error('Не удалось скачать нейросеть (' + r.status + ')');
  const total = Number(r.headers.get('content-length')) || 180534758;
  const reader = r.body.getReader();
  const buf = new Uint8Array(total);
  let loaded = 0, chunks = null, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!chunks && loaded + value.length <= buf.length) buf.set(value, loaded);
    else { // размер не совпал с заголовком — собираем по кускам
      if (!chunks) chunks = [buf.subarray(0, loaded)];
      chunks.push(value);
    }
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 250) { lastPost = now; post({ type: 'download', loaded, total }); }
  }
  post({ type: 'download', loaded, total: loaded });
  let out;
  if (chunks) { out = new Uint8Array(loaded); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } }
  else out = loaded === buf.length ? buf : buf.slice(0, loaded);
  try {
    const c = await caches.open(MODEL_CACHE);
    await c.put(MODEL_URL, new Response(new Blob([out]), { headers: { 'content-type': 'application/octet-stream' } }));
  } catch (e) { /* нет места — в следующий раз скачаем снова */ }
  return out.buffer;
}

async function hasWebGPU() {
  try { return Boolean(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch (e) { return false; }
}

async function ensureSession() {
  if (session) return;
  post({ type: 'stage', stage: 'model' });
  let model = await cachedModel();
  if (!model) model = await downloadModel();
  post({ type: 'stage', stage: 'init' });
  const opts = { graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false };
  if (await hasWebGPU()) {
    try { session = await ort.InferenceSession.create(model, { ...opts, executionProviders: ['webgpu'] }); backend = 'webgpu'; } catch (e) { session = null; }
  }
  if (!session) { session = await ort.InferenceSession.create(model, { ...opts, executionProviders: ['wasm'] }); backend = 'wasm'; }
  post({ type: 'stage', stage: 'ready', backend });
}

/* Тот же алгоритм, что DemucsProcessor.separate (demucs-web), но вместо
   четырёх партий сразу копим их сумму с весами keep[]. */
async function separateMix(left, right, keep) {
  const total = left.length;
  const stride = Math.floor(TRAINING_SAMPLES * (1 - SEGMENT_OVERLAP));
  const numSegments = Math.max(1, Math.ceil((total - TRAINING_SAMPLES) / stride) + 1);
  const outL = new Float32Array(total), outR = new Float32Array(total);
  const weights = new Float32Array(total);
  let seg = 0;
  for (let start = 0; start < total; start += stride) {
    const end = Math.min(start + TRAINING_SAMPLES, total);
    const len = end - start;
    const segL = new Float32Array(TRAINING_SAMPLES), segR = new Float32Array(TRAINING_SAMPLES);
    segL.set(left.subarray(start, end)); segR.set(right.subarray(start, end));
    const input = prepareModelInput(segL, segR);
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', input.waveform, [1, 2, TRAINING_SAMPLES]);
    if (session.inputNames.length > 1) feeds[session.inputNames[1]] = new ort.Tensor('float32', input.magSpec, [1, 4, input.numBins, input.numFrames]);
    const res = await session.run(feeds);
    let timeData = null, timeShape = null, freqData = null;
    for (const name of session.outputNames) {
      const t = res[name];
      if (t.dims.length === 4 && t.dims[2] === 2) { timeData = t.data; timeShape = t.dims; }
      else if (t.dims.length === 5 && t.dims[2] === 4) freqData = t.data;
    }
    if (!timeData) throw new Error('Нейросеть вернула неожиданный ответ');
    const nCh = timeShape[2], samples = timeShape[3];
    const specs = freqData ? standaloneMask(freqData) : null;
    const win = new Float32Array(len);
    for (let i = 0; i < len; i++) win[i] = Math.min(Math.min(i / (stride * 0.5), 1), Math.min((len - i) / (stride * 0.5), 1));
    for (let tr = 0; tr < 4; tr++) {
      const g = keep[tr];
      if (!g) continue;
      const freq = specs ? standaloneIspec(specs[tr], TRAINING_SAMPLES) : null;
      const base = tr * nCh * samples;
      for (let i = 0; i < len; i++) {
        const l = timeData[base + i] + (freq ? (freq.left[i] || 0) : 0);
        const r = timeData[base + samples + i] + (freq ? (freq.right[i] || 0) : 0);
        outL[start + i] += l * win[i] * g;
        outR[start + i] += r * win[i] * g;
      }
    }
    for (let i = 0; i < len; i++) weights[start + i] += win[i];
    seg++;
    post({ type: 'progress', p: seg / numSegments });
  }
  for (let i = 0; i < total; i++) if (weights[i] > 0) { outL[i] /= weights[i]; outR[i] /= weights[i]; }
  return [outL, outR];
}

/* 16-битный WAV. Сумма партий может чуть превысить 0 дБ — мягко нормируем. */
function encodeWav(l, r, rate) {
  let peak = 0;
  for (let i = 0; i < l.length; i++) { const a = Math.abs(l[i]), b = Math.abs(r[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
  const k = peak > 0.99 ? 0.98 / peak : 1;
  const n = l.length, bytes = 44 + n * 4;
  const buf = new ArrayBuffer(bytes), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, l[i] * k)), b = Math.max(-1, Math.min(1, r[i] * k));
    v.setInt16(o, a < 0 ? a * 0x8000 : a * 0x7fff, true); v.setInt16(o + 2, b < 0 ? b * 0x8000 : b * 0x7fff, true);
    o += 4;
  }
  return buf;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type !== 'run') return;
  try {
    await ensureSession();
    post({ type: 'stage', stage: 'separate', backend });
    const [l, r] = await separateMix(m.left, m.right, m.keep);
    post({ type: 'stage', stage: 'encode' });
    const wav = encodeWav(l, r, SAMPLE_RATE);
    post({ type: 'done', wav, backend }, [wav]);
  } catch (err) {
    post({ type: 'error', message: String(err && err.message || err) });
  }
};
