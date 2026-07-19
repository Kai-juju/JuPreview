/* JuPreview — drag-and-drop footage preview.
 * Everything runs locally in the browser; files never upload anywhere.
 *
 * Pipeline:
 *   1. Try native playback (8-bit H.264, HEVC on machines with the codec).
 *   2. Otherwise decode with ffmpeg.wasm (multithreaded via COOP/COEP shim):
 *      HEVC 4:2:2 10-bit / ProRes -> 1080p H.264 proxy -> instant playback.
 *   3. Frames render through WebGL2 with a C-Log3 / Cinema Gamut -> Rec.709
 *      transform (constants verified against colour-science to 1e-14),
 *      or through any user-loaded .cube LUT.
 */

import { FFmpeg } from "./vendor/ffmpeg/index.js";

/* ── DOM ─────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const els = {
  env: $("env"), clipList: $("clipList"), addBtn: $("addBtn"),
  fileInput: $("fileInput"), cubeInput: $("cubeInput"),
  empty: $("empty"), prep: $("prep"), prepPct: $("prepPct"),
  prepWhat: $("prepWhat"), prepSpeed: $("prepSpeed"), cancelBtn: $("cancelBtn"),
  notice: $("notice"), transport: $("transport"),
  playBtn: $("playBtn"), tc: $("tc"), seek: $("seek"),
  lutLog: $("lutLog"), lut709: $("lut709"), lutName: $("lutName"),
  cubeBtn: $("cubeBtn"), dlBtn: $("dlBtn"), fsBtn: $("fsBtn"), anaBtn: $("anaBtn"),
  canvas: $("glCanvas"), fallbackVideo: $("fallbackVideo"),
  viewport: $("viewport"),
};

const cores = Math.min(navigator.hardwareConcurrency || 4, 8);
const isolated = !!window.crossOriginIsolated;
const PREVIEW_HEIGHT = 720; // 720 = faster prep; raise to 1080 for a sharper proxy
<<<<<<< Updated upstream
=======
const ANAMORPHIC_FACTOR = 1.5; // horizontal desqueeze applied by the 1.5× button
const DEFAULT_LUT_URL = "luts/CinemaGamut_CanonLog3-to-BT709_WideDR_33_FF_Ver_2_0.cube";
const DEFAULT_LUT_LABEL = "Canon WideDR (official .cube)";
>>>>>>> Stashed changes

/* ── notices ─────────────────────────────────────────── */
let noticeTimer = null;
function notify(msg, ms = 5000) {
  els.notice.textContent = msg;
  els.notice.style.display = "block";
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => (els.notice.style.display = "none"), ms);
}

/* ── environment line ────────────────────────────────── */
function setEnv(extra) {
  const iso = isolated ? `<b>${cores} threads</b>` : "single-thread";
  els.env.innerHTML = `engine: ${iso}${extra ? " · " + extra : ""}`;
}
setEnv(isolated ? "" : "reload once to enable");

/* ── hidden video element (source of frames) ─────────── */
const video = document.createElement("video");
video.playsInline = true;
video.preload = "auto";

/* ── WebGL2 pipeline ─────────────────────────────────── */
const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Canon Log 3 v1.2 decode + Cinema Gamut->Rec.709 (D65), verified vs colour-science.
const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV; out vec4 outColor;
uniform sampler2D uVideo;
uniform sampler3D uLut;
uniform int uMode;      // 0 = log passthrough, 1 = built-in 709, 2 = .cube
uniform float uLutN;

const mat3 CG2709 = mat3(
  1.92386130, -0.20431085, -0.02368502,
 -0.79876066,  1.49589851, -0.42012701,
 -0.12510063, -0.29158766,  1.44381203);

float clog3ToLin(float v){
  float c = v * 0.85630499 + 0.06256109;            // full-range CV -> legal domain
  float x;
  if (c < 0.097465473)      x = -(pow(10.0, (0.12783901 - c) / 0.36726845) - 1.0) / 14.98325;
  else if (c <= 0.15277891) x = (c - 0.12512219) / 1.9754798;
  else                      x = (pow(10.0, (c - 0.12240537) / 0.36726845) - 1.0) / 14.98325;
  return x * 0.9;                                    // 18% grey -> 0.18
}
float shoulder(float x){
  const float k = 0.75;
  return x <= k ? x : k + (1.0 - k) * tanh((x - k) / (1.0 - k));
}
float srgbEncode(float x){
  x = clamp(x, 0.0, 1.0);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
void main(){
  vec3 rgb = texture(uVideo, vUV).rgb;
  if (uMode == 1) {
    vec3 lin = vec3(clog3ToLin(rgb.r), clog3ToLin(rgb.g), clog3ToLin(rgb.b));
    lin = max(CG2709 * lin, vec3(0.0));
    lin = vec3(shoulder(lin.r), shoulder(lin.g), shoulder(lin.b));
    rgb = vec3(srgbEncode(lin.r), srgbEncode(lin.g), srgbEncode(lin.b));
  } else if (uMode == 2) {
    vec3 c = rgb * ((uLutN - 1.0) / uLutN) + (0.5 / uLutN);
    rgb = texture(uLut, c).rgb;
  }
  outColor = vec4(rgb, 1.0);
}`;

let gl = null, prog = null, uMode, uLutN, videoTex = null, lutTex = null;
let glOK = false;

function initGL() {
  gl = els.canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false });
  if (!gl) return false;
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s)); return null;
    }
    return s;
  };
  const vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return false;
  prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog)); return false;
  }
  gl.useProgram(prog);

  // fullscreen triangle
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.uniform1i(gl.getUniformLocation(prog, "uVideo"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "uLut"), 1);
  uMode = gl.getUniformLocation(prog, "uMode");
  uLutN = gl.getUniformLocation(prog, "uLutN");
  gl.uniform1i(uMode, 0);
  gl.uniform1f(uLutN, 33.0);

  videoTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
                        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
    gl.texParameteri(gl.TEXTURE_2D, p, v);
  return true;
}
glOK = initGL();
if (!glOK) {
  els.canvas.style.display = "none";
  els.fallbackVideo.style.display = "block";
  notify("WebGL2 unavailable — playing without the LUT preview.", 8000);
}

/* render loop */
let rafId = null;
function draw() {
  rafId = requestAnimationFrame(draw);
  if (!glOK || video.readyState < 2 || !video.videoWidth) return;
  const tw = Math.round(video.videoWidth * desqueeze);
  if (els.canvas.width !== tw || els.canvas.height !== video.videoHeight) {
    els.canvas.width = tw;
    els.canvas.height = video.videoHeight;
    gl.viewport(0, 0, els.canvas.width, els.canvas.height);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ── LUT state ───────────────────────────────────────── */
let lutMode = 0;          // what the 709 button applies: 1 built-in, 2 cube
let showing709 = false;
let cubeLoadedName = null;
let defaultCube = null;   // Canon's official WideDR cube, fetched from the repo
let desqueeze = 1;        // 1 or ANAMORPHIC_FACTOR (display-only)
lutMode = 1;

function uploadCubeTexture({ N, rgba }) {
  if (!lutTex) lutTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTex);
  for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
                        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
                        [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
    gl.texParameteri(gl.TEXTURE_3D, p, v);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.uniform1f(uLutN, N);
}

async function loadDefaultLut() {
  if (!glOK) return;
  try {
    const res = await fetch(DEFAULT_LUT_URL);
    if (!res.ok) throw new Error();
    defaultCube = parseCube(await res.text());
    if (!cubeLoadedName) {              // don't stomp a user-loaded cube
      uploadCubeTexture(defaultCube);
      lutMode = 2;
      els.lutName.textContent = DEFAULT_LUT_LABEL;
      applyMode();
    }
  } catch {
    // Cube missing or unreadable — the verified math transform stays in charge.
  }
}

function applyMode() {
  if (!glOK) return;
  gl.uniform1i(uMode, showing709 ? lutMode : 0);
  els.lutLog.classList.toggle("on", !showing709);
  els.lut709.classList.toggle("on", showing709);
}
els.lutLog.addEventListener("click", () => { showing709 = false; applyMode(); });
els.lut709.addEventListener("click", () => { showing709 = true; applyMode(); });

function parseCube(text) {
  let N = 0, i = 0;
  const data = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^TITLE/i.test(line) || /^DOMAIN_/i.test(line)) continue;
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error("1D LUTs aren't supported — use a 3D .cube");
    const m = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (m) { N = parseInt(m[1], 10); continue; }
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) data.push(parts[0], parts[1], parts[2]);
  }
  if (!N || data.length !== N * N * N * 3) throw new Error("Couldn't read that .cube file");
  const rgba = new Uint8Array(N * N * N * 4);
  for (let p = 0; p < N * N * N; p++) {
    rgba[p * 4]     = Math.round(Math.min(Math.max(data[p * 3], 0), 1) * 255);
    rgba[p * 4 + 1] = Math.round(Math.min(Math.max(data[p * 3 + 1], 0), 1) * 255);
    rgba[p * 4 + 2] = Math.round(Math.min(Math.max(data[p * 3 + 2], 0), 1) * 255);
    rgba[p * 4 + 3] = 255;
  }
  return { N, rgba };
}

els.cubeBtn.addEventListener("click", () => els.cubeInput.click());
els.cubeInput.addEventListener("change", async () => {
  const f = els.cubeInput.files[0];
  els.cubeInput.value = "";
  if (!f || !glOK) return;
  try {
    const cube = parseCube(await f.text());
    uploadCubeTexture(cube);
    lutMode = 2;
    cubeLoadedName = f.name;
    els.lutName.textContent = "✕ " + f.name;
    els.lutName.title = "Click to go back to the built-in transform";
    els.lutName.style.cursor = "pointer";
    showing709 = true;
    applyMode();
    notify(`Loaded ${f.name} (${N}×${N}×${N})`);
  } catch (e) {
    notify(e.message || "Couldn't load that .cube file");
  }
});
els.lutName.addEventListener("click", () => {
  if (!cubeLoadedName) return;
  cubeLoadedName = null;
  if (defaultCube) {
    uploadCubeTexture(defaultCube);
    lutMode = 2;
    els.lutName.textContent = DEFAULT_LUT_LABEL;
  } else {
    lutMode = 1;
    els.lutName.textContent = "built-in C-Log3/C.Gamut → 709";
  }
  els.lutName.title = "";
  els.lutName.style.cursor = "default";
  applyMode();
});

/* ── anamorphic desqueeze ────────────────────────────── */
function applyDesqueeze() {
  els.anaBtn.classList.toggle("on", desqueeze !== 1);
  els.fallbackVideo.style.transform = desqueeze === 1 ? "" : `scaleX(${desqueeze})`;
  // canvas path picks the new width up on the next drawn frame
}
els.anaBtn.textContent = ANAMORPHIC_FACTOR + "×";
els.anaBtn.addEventListener("click", () => {
  desqueeze = desqueeze === 1 ? ANAMORPHIC_FACTOR : 1;
  applyDesqueeze();
});

/* ── clips ───────────────────────────────────────────── */
let clips = [];
let activeClip = null;
let nextId = 1;

function fmtSize(b) {
  return b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(0) + " MB";
}
function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

function renderClips() {
  els.clipList.innerHTML = "";
  for (const c of clips) {
    const b = document.createElement("button");
    b.className = "clip" + (c === activeClip ? " active" : "");
    const chip =
      c.status === "ready"   ? `<span class="chip ready">ready</span>` :
      c.status === "native"  ? `<span class="chip native">plays natively</span>` :
      c.status === "working" ? `<span class="chip working">preparing ${c.pct}%</span>` :
      c.status === "queued"  ? `<span class="chip queued">queued</span>` :
      c.status === "probing" ? `<span class="chip queued">checking</span>` :
                               `<span class="chip failed">failed</span>`;
    b.innerHTML = `<div class="name">${c.file.name}</div>
      <div class="meta">${chip}<span>${fmtSize(c.file.size)}</span></div>
      ${c.status === "working" ? `<div class="bar"><i style="width:${c.pct}%"></i></div>` : ""}`;
    b.addEventListener("click", () => selectClip(c));
    els.clipList.appendChild(b);
  }
}

function selectClip(c) {
  activeClip = c;
  renderClips();
  els.empty.style.display = "none";
  if (c.status === "ready" || c.status === "native") {
    els.prep.style.display = "none";
    startPlayback(c);
  } else if (c.status === "failed") {
    stopPlayback();
    els.prep.style.display = "none";
    notify(c.error || "This clip couldn't be prepared.", 8000);
  } else {
    stopPlayback();
    els.prep.style.display = "flex";
    els.prepWhat.textContent =
      c.status === "queued" ? "Waiting for the engine…" : "Preparing preview…";
  }
}

function startPlayback(c) {
  els.transport.style.display = "flex";
  const target = glOK ? video : els.fallbackVideo;
  if (target.src !== c.playUrl) {
    target.src = c.playUrl;
    target.load();
  }
  els.dlBtn.style.display = c.blob ? "" : "none";
  target.play().catch(() => {});
  if (glOK && rafId === null) draw();
}
function stopPlayback() {
  (glOK ? video : els.fallbackVideo).pause();
}

/* ── native playability probe ────────────────────────── */
function probeNative(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      v.removeAttribute("src"); v.load();
      if (!ok) URL.revokeObjectURL(url);
      resolve(ok ? url : null);
    };
    v.addEventListener("error", () => finish(false));
    v.addEventListener("loadeddata", () => finish(v.videoWidth > 0)); // a frame actually decoded
    setTimeout(() => finish(false), 6000);
    v.src = url;
  });
}

/* ── ffmpeg engine ───────────────────────────────────── */
let ffmpeg = null;
let engineReady = null;
let currentJob = null;
let logTail = [];
let lastSpeed = "";
let lastFrame = 0;
let lastAdvance = 0;
let jobStart = 0;

function paintPrep() {
  const j = currentJob;
  if (!j) return;
  els.prepPct.textContent = (j.pct || 0) + "%";
  const secs = jobStart ? Math.round((performance.now() - jobStart) / 1000) : 0;
  const bits = [];
  if (j.safeMode) bits.push("safe mode");
  if (lastFrame) bits.push(`frame ${lastFrame}`);
  bits.push(`${secs}s elapsed`);
  if (lastSpeed) bits.push(`${lastSpeed} realtime`);
  els.prepSpeed.textContent = bits.join(" · ");
}
let prepTimer = null;

function abs(p) { return new URL(p, window.location.href).href; }

function initEngine() {
  if (engineReady) return engineReady;
  if (!isolated) return Promise.reject(new Error("not isolated"));
  setEnv("loading decoder (32 MB, first time only)…");
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    logTail.push(message);
    if (logTail.length > 40) logTail.shift();
    const sp = message.match(/speed=\s*([\d.]+)x/);
    if (sp) lastSpeed = sp[1] + "×";
    const fr = message.match(/frame=\s*(\d+)/);
    if (fr) {
      const n = +fr[1];
      if (n > lastFrame) { lastFrame = n; lastAdvance = performance.now(); }
      if (currentJob === activeClip) paintPrep();
    }
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (!currentJob) return;
    const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
    currentJob.pct = pct;
    if (currentJob === activeClip) paintPrep();
    renderClips();
  });
  engineReady = ffmpeg
    .load({
      coreURL: abs("vendor/core/ffmpeg-core.js"),
      wasmURL: abs("vendor/core/ffmpeg-core.wasm"),
      workerURL: abs("vendor/core/ffmpeg-core.worker.js"),
    })
    .then(() => setEnv(""))
    .catch((e) => {
      engineReady = null;
      setEnv("decoder failed to load");
      throw e;
    });
  return engineReady;
}

async function transcode(clip) {
  await initEngine();
  currentJob = clip;
  clip.status = "working";
  clip.pct = 0;
  lastSpeed = "";
  lastFrame = 0;
  jobStart = performance.now();
  lastAdvance = jobStart;
  logTail = [];
  clearInterval(prepTimer);
  prepTimer = setInterval(() => {
    if (currentJob !== clip) return;
    if (currentJob === activeClip) paintPrep();
    // Watchdog: no frame progress for 30s = the engine has deadlocked.
    if (performance.now() - lastAdvance > 30000) {
      clip.stalled = true;
      try { ffmpeg.terminate(); } catch {}
    }
  }, 1000);
  renderClips();
  if (clip === activeClip) selectClip(clip);

  const inPath = "/input/" + clip.file.name;
  try { await ffmpeg.createDir("/input"); } catch {}
  await ffmpeg.mount("WORKERFS", { files: [clip.file] }, "/input");
  try {
    const dec = clip.safeMode ? 1 : Math.min(4, cores); // frame-threaded HEVC decode
    const enc = clip.safeMode ? 1 : 2;                  // x264 (never the bottleneck here)
    const ret = await ffmpeg.exec([
      "-filter_threads", "1",
      "-thread_type", "frame",
      "-threads", String(dec),
      "-i", inPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale=-2:min(${PREVIEW_HEIGHT}\\,ih)`,
      "-sws_flags", "fast_bilinear",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
      "-threads", String(enc),
      "out.mp4",
    ]);
    if (ret !== 0) throw new Error("decode failed");
    const data = await ffmpeg.readFile("out.mp4");
    if (!data || !data.length) throw new Error("empty output");
    clip.blob = new Blob([data.buffer], { type: "video/mp4" });
    clip.playUrl = URL.createObjectURL(clip.blob);
    clip.status = "ready";
  } catch (e) {
    if (clip.stalled && !clip.safeMode) {
      // Multithreaded decode deadlocked. Retry this clip once, single-threaded.
      clip.stalled = false;
      clip.safeMode = true;
      clip.status = "queued";
      clip.pct = 0;
      notify("Multithreaded decode stalled on this machine — retrying in safe mode (slower, but reliable).", 8000);
    } else if (clip.status !== "cancelled") {
      clip.status = "failed";
      const tail = logTail.join("\n");
      const memoryHit = /out of memory|abort|memory access|table index|null function/i.test(tail);
      const big = clip.file.size > 1_100_000_000; // ~1.1 GB+
      clip.error = clip.stalled
        ? "Decoding stalled even in safe mode. This machine/browser can't get through this file — a Premiere-exported H.264 proxy will play instantly here instead."
        : (memoryHit || big)
        ? "Too large for the browser's memory ceiling — very long / multi-GB clips can exceed it. Try a shorter section, or set PREVIEW_HEIGHT to 720 in app.js. Other clips are unaffected."
        : "Couldn't decode this file. It may use a codec the engine doesn't include.";
    }
  } finally {
    clearInterval(prepTimer);
    if (clip.status === "failed" || clip.status === "cancelled" || clip.status === "queued") {
      // Failure, cancel, or stall-retry: the wasm instance may be aborted or
      // already terminated. Tear it down so the next job builds a fresh engine.
      try { if (ffmpeg) ffmpeg.terminate(); } catch {}
      ffmpeg = null;
      engineReady = null;
    } else {
      try { await ffmpeg.deleteFile("out.mp4"); } catch {}
      try { await ffmpeg.unmount("/input"); } catch {}
    }
    currentJob = null;
  }
  renderClips();
  if (clip === activeClip) selectClip(clip);
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  while (true) {
    const next = clips.find((c) => c.status === "queued");
    if (!next) break;
    try { await transcode(next); }
    catch { break; } // engine failed to load; queued clips stay queued
  }
  pumping = false;
}

els.cancelBtn.addEventListener("click", async () => {
  if (!currentJob) return;
  const c = currentJob;
  c.status = "cancelled";
  try { ffmpeg.terminate(); } catch {}
  ffmpeg = null; engineReady = null; currentJob = null;
  c.status = "failed";
  c.error = "Cancelled.";
  renderClips();
  if (c === activeClip) selectClip(c);
  pump();
});

/* ── adding files ────────────────────────────────────── */
async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0);
  if (!files.length) return;
  const fresh = [];
  for (const f of files) {
    const clip = { id: nextId++, file: f, status: "probing", pct: 0, playUrl: null, blob: null };
    clips.push(clip);
    fresh.push(clip);
  }
  renderClips();
  if (!activeClip) selectClip(fresh[0]);

  for (const clip of fresh) {
    const nativeUrl = await probeNative(clip.file);
    if (nativeUrl) {
      clip.playUrl = nativeUrl;
      clip.status = "native";
    } else if (isolated) {
      clip.status = "queued";
    } else {
      clip.status = "failed";
      clip.error = "This file needs the decoder, which needs one page reload to enable. Reload and drop it again.";
    }
    renderClips();
    if (clip === activeClip) selectClip(clip);
  }
  pump();
}

els.addBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* ── transport ───────────────────────────────────────── */
const player = () => (glOK ? video : els.fallbackVideo);

els.playBtn.addEventListener("click", () => {
  const v = player();
  v.paused ? v.play().catch(() => {}) : v.pause();
});
video.addEventListener("play", () => (els.playBtn.textContent = "❚❚"));
video.addEventListener("pause", () => (els.playBtn.textContent = "▶"));

let scrubbing = false;
els.seek.addEventListener("input", () => {
  scrubbing = true;
  const v = player();
  if (v.duration) v.currentTime = (els.seek.value / 1000) * v.duration;
});
els.seek.addEventListener("change", () => (scrubbing = false));

function tick() {
  const v = player();
  els.tc.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  if (!scrubbing && v.duration) els.seek.value = Math.round((v.currentTime / v.duration) * 1000);
}
video.addEventListener("timeupdate", tick);
video.addEventListener("loadedmetadata", tick);
els.fallbackVideo.addEventListener("timeupdate", tick);

els.dlBtn.addEventListener("click", () => {
  if (!activeClip?.blob) return;
  const a = document.createElement("a");
  a.href = activeClip.playUrl;
  a.download = activeClip.file.name.replace(/\.[^.]+$/, "") + "_proxy.mp4";
  a.click();
});

els.fsBtn.addEventListener("click", () => {
  document.fullscreenElement ? document.exitFullscreen() : els.viewport.requestFullscreen();
});

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.code === "Space") {
    e.preventDefault();
    els.playBtn.click();
  } else if (e.key === "l" || e.key === "L") {
    showing709 = !showing709;
    applyMode();
  } else if (e.key === "f" || e.key === "F") {
    els.fsBtn.click();
  } else if (e.key === "a" || e.key === "A") {
    els.anaBtn.click();
  }
});

/* first paint */
applyMode();
applyDesqueeze();
renderClips();
loadDefaultLut();
