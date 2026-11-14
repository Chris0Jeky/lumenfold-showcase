'use strict';
// Replaced only after build.sh has run the real native replay successfully.
const NATIVE_HASH = '88146bd55aee1626';
const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const format = n => n.toLocaleString('en-GB');
const DT = 1 / 30;
let core, gl, program, buffers, attributes, scaleUniform, pointUniform;
let paused = false, busy = false, probe = null, pointer = null;
let half = 1, steps = 0, accumulator = 0, last = 0, fpsStart = 0, frames = 0;
let loadMs = 0, wasmBytes = 0, lastTarget = 0, dirtyTarget = false;
const canvas = $('scene');

function fail(error) {
  text('status', error.message || String(error));
  $('status').className = 'bad';
}
function checkCore() {
  const error = core.UTF8ToString(core._last_error());
  if (error) throw new Error(error);
}
function shapeState(shape) {
  document.querySelectorAll('[data-shape]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.shape) === shape)));
}
function controls(enabled) {
  document.querySelectorAll('button, input').forEach(e => { e.disabled = !enabled; });
  if (probe) { $('ceiling').disabled = false; }
}
function recreate(n) {
  if (!core._create(n, 1234)) { checkCore(); throw new Error('Create failed'); }
  half = core._world_half();
  steps = 0; accumulator = 0; pointer = null; dirtyTarget = false;
  $('count').value = n;
  text('count-label', format(n)); text('agents', format(n));
  shapeState(1);
}

function shader(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function renderer() {
  gl = canvas.getContext('webgl', {alpha: false, antialias: false, depth: false, powerPreference: 'low-power'});
  if (!gl) throw new Error('WebGL is unavailable in this browser.');
  program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `
    attribute float x; attribute float y; uniform vec2 scale; uniform float point;
    varying vec3 tint;
    void main() {
      gl_Position = vec4(x * scale.x, y * scale.y, 0.0, 1.0);
      gl_PointSize = point;
      float t = clamp(0.5 + y * scale.y * 0.6, 0.0, 1.0);
      tint = mix(vec3(0.25, 0.64, 0.95), vec3(0.48, 1.0, 0.76), t);
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
    precision mediump float; varying vec3 tint;
    void main() { gl_FragColor = vec4(tint, 1.0); }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  attributes = ['x', 'y'].map(name => gl.getAttribLocation(program, name));
  buffers = [gl.createBuffer(), gl.createBuffer()];
  scaleUniform = gl.getUniformLocation(program, 'scale');
  pointUniform = gl.getUniformLocation(program, 'point');
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); paused = true; finishProbe('Cancelled: graphics context lost.');
    fail(new Error('Graphics context lost; reload to restore the renderer.'));
  });
}
function viewExtents() {
  const aspect = canvas.clientWidth / canvas.clientHeight;
  return [half * 0.84 * Math.max(1, aspect), half * 0.84 * Math.max(1, 1 / aspect)];
}
function draw() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * ratio), h = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.031, 0.059, 0.102, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const [ex, ey] = viewExtents();
  gl.uniform2f(scaleUniform, 1 / ex, 1 / ey);
  gl.uniform1f(pointUniform, (core._count() > 80000 ? 1.2 : 1.8) * ratio);
  // Reacquire HEAPF32 and pointers every draw: wasm memory and the core's double
  // buffers can move. Upload the real SoA positions, without a JS simulation.
  const n = core._count();
  [core._positions_x(), core._positions_y()].forEach((ptr, axis) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers[axis]);
    gl.bufferData(gl.ARRAY_BUFFER, core.HEAPF32.subarray(ptr >>> 2, (ptr >>> 2) + n), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attributes[axis]);
    gl.vertexAttribPointer(attributes[axis], 1, gl.FLOAT, false, 0, 0);
  });
  gl.drawArrays(gl.POINTS, 0, n);
}
function locationOf(e) {
  const r = canvas.getBoundingClientRect(), [ex, ey] = viewExtents();
  return [(2 * (e.clientX - r.left) / r.width - 1) * ex,
          (1 - 2 * (e.clientY - r.top) / r.height) * ey];
}

function finishProbe(message) {
  if (!probe) return;
  text('ceiling-result', message);
  probe = null; text('ceiling', 'Find 60 fps ceiling'); controls(true);
}
function probeStage(n, now) {
  recreate(n);
  probe.n = n; probe.start = now; probe.samples = []; probe.dropped = 0;
  text('ceiling-result', `Testing ${format(n)} agents…`);
}
function measureProbe(now, frameMs, dropped) {
  if (!probe) return;
  // The interval that crossed the warmup boundary is excluded in full.
  if (now - probe.start > 1500 + frameMs) {
    probe.samples.push(frameMs); probe.dropped += dropped;
  }
  if (now - probe.start < 5500) return;
  const samples = probe.samples;
  const elapsed = samples.reduce((a, b) => a + b, 0);
  const fps = samples.length * 1000 / elapsed;
  const ordered = [...samples].sort((a, b) => a - b);
  const p95 = ordered[Math.floor(ordered.length * 0.95)] || Infinity;
  const pass = samples.length >= 120 && fps >= 59.5 && p95 <= 18.5 && probe.dropped === 0;
  $('probe-log').textContent += `${format(probe.n)}: ${fps.toFixed(1)} fps, p95 ${p95.toFixed(1)} ms, dropped ${probe.dropped} — ${pass ? 'PASS' : 'FAIL'}\n`;
  $('probe-log').scrollTop = $('probe-log').scrollHeight;
  if (pass) probe.best = probe.n;
  if (!pass || probe.n === 200000) {
    const answer = probe.best ? `${format(probe.best)} agents held the 60 fps target${pass ? ' (slider maximum)' : ' (largest tested pass)'}.` : 'No tested count held the 60 fps target.';
    finishProbe(`${answer} Wasm ${format(wasmBytes)} bytes; load ${loadMs.toFixed(0)} ms.`);
    return;
  }
  const next = Math.min(200000, probe.n < 10000 ? probe.n + 1000 : Math.ceil(probe.n * 1.35 / 1000) * 1000);
  probeStage(next, performance.now());
  // Exclude the setup/assignment cost from the next steady-state interval.
  last = performance.now();
}

function frame(now) {
  const frameMs = last ? now - last : 1000 / 60;
  last = now;
  try {
    let dropped = 0;
    if (!busy && !paused) {
      if (pointer && dirtyTarget && now - lastTarget >= 100) {
        core._target(...pointer); checkCore(); shapeState(-1);
        lastTarget = now; dirtyTarget = false;
      }
      accumulator += Math.min(frameMs / 1000, 0.25);
      let catchup = 0;
      while (accumulator >= DT && catchup < 3) {
        core._step(1); checkCore(); accumulator -= DT; steps++; catchup++;
      }
      if (accumulator >= DT) { dropped = Math.floor(accumulator / DT); accumulator %= DT; }
      if (frameMs > 250) dropped += Math.floor((frameMs - 250) / (DT * 1000));
    }
    draw();
    frames++;
    if (now - fpsStart >= 750) {
      text('fps', (frames * 1000 / (now - fpsStart)).toFixed(1));
      text('ticks', format(steps)); fpsStart = now; frames = 0;
    }
    measureProbe(now, frameMs, dropped);
    requestAnimationFrame(frame);
  } catch (e) { finishProbe('Stopped after a core/renderer error.'); fail(e); }
}

async function start() {
  text('native-hash', NATIVE_HASH);
  const begin = performance.now();
  core = await SwarmModule({
    // Fetch exactly once, measuring actual transferred wasm payload size rather
    // than Content-Length (which may be absent or compressed by a static host).
    instantiateWasm(imports, receive) {
      (async () => {
        const response = await fetch(new URL('swarm.wasm', location.href));
        if (!response.ok) throw new Error(`Wasm load: HTTP ${response.status}`);
        const bytes = await response.arrayBuffer(); wasmBytes = bytes.byteLength;
        const result = await WebAssembly.instantiate(bytes, imports);
        receive(result.instance, result.module);
      })().catch(fail);
      return {};
    }
  });
  loadMs = performance.now() - begin;
  text('load', `Wasm ${format(wasmBytes)} bytes · load + compile ${loadMs.toFixed(0)} ms`);
  renderer(); recreate(20000); controls(true);
  text('status', 'Ready. Choose a silhouette, or hold the pointer to pull the swarm out of formation.');

  $('count').addEventListener('input', e => text('count-label', format(Number(e.target.value))));
  $('count').addEventListener('change', e => { try { recreate(Number(e.target.value)); last = performance.now(); } catch (err) { fail(err); } });
  $('shapes').addEventListener('click', e => {
    if (!e.target.dataset.shape || busy || probe) return;
    try { const shape = Number(e.target.dataset.shape); core._set_formation(shape); checkCore(); shapeState(shape); last = performance.now(); } catch (err) { fail(err); }
  });
  $('scatter').addEventListener('click', () => { core._scatter(0, 0); checkCore(); shapeState(-1); });
  $('pause').addEventListener('click', () => { paused = !paused; accumulator = 0; text('pause', paused ? 'Resume' : 'Pause'); });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    if (busy || probe) return;
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) { core._scatter(...locationOf(e)); checkCore(); shapeState(-1); }
    else if (e.button === 0) { pointer = locationOf(e); dirtyTarget = true; }
  });
  canvas.addEventListener('pointermove', e => { if (pointer) { pointer = locationOf(e); dirtyTarget = true; } });
  const release = () => { pointer = null; dirtyTarget = false; };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);
  document.addEventListener('visibilitychange', () => {
    release(); accumulator = 0; last = 0;
    if (document.hidden) finishProbe('Cancelled: keep the page visible while measuring.');
  });
  $('verify').addEventListener('click', () => {
    busy = true; controls(false); text('verdict', 'Computing 600 real core steps…');
    // Let the progress text paint before entering the synchronous C++ replay.
    setTimeout(() => {
      try {
        const value = core.UTF8ToString(core._verify(600)); checkCore();
        text('wasm-hash', value);
        const equal = value === NATIVE_HASH;
        text('verdict', equal ? 'EQUAL — browser and native hashes match.' : 'NOT EQUAL — browser and native hashes differ.');
        $('verdict').className = equal ? 'equal' : 'bad';
      } catch (e) { fail(e); text('verdict', 'Verification failed.'); }
      finally { busy = false; controls(true); last = performance.now(); accumulator = 0; fpsStart = last; frames = 0; }
    }, 50);
  });
  $('ceiling').addEventListener('click', () => {
    if (probe) { finishProbe('Cancelled.'); return; }
    if (document.hidden) return;
    paused = false; text('pause', 'Pause'); pointer = null;
    probe = {best: 0}; text('probe-log', ''); controls(false); text('ceiling', 'Cancel measurement');
    probeStage(1000, performance.now()); last = performance.now();
  });
  fpsStart = performance.now(); requestAnimationFrame(frame);
}
start().catch(fail);
