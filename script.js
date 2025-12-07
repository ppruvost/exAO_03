/************************************************************
 * script.js - exAO_03 (VERSION RECONSTRUITE)
 *
 * - détection automatique : balle de tennis (HSV) OU mire
 * - subtraction de fond (moyenne) pour robustesse éclairage
 * - calibration pixel -> m via détection diamètre balle
 * - filtre de Kalman 2D pour lissage
 * - estimation angle plan par PCA (axe principal)
 * - graphiques Chart.js (position & vitesse)
 * - export CSV
 * - support : webcam (preview + record) et fichier importé
 * - protection contre "frame noire" initiale
 ************************************************************/

/* =========================
   CONFIG
   ========================= */
const CONFIG = {
  FRAME_STEP_MS: 33,            // pas traitement lors du process (ms)
  BG_FRAMES: 18,                // nb frames pour estimer background
  MIN_PIXELS_BALL: 40,
  MIN_PIXELS_MIRE: 120,
  BALL_REAL_DIAM_M: 0.20,       // 20 cm
  HSV: { H_MIN: 40, H_MAX: 75, S_MIN: 0.28, V_MIN: 0.45 },
  MOTION_DIFF_THRESHOLD: 55,    // for bg subtraction fallback
  STRIDE: 2,                    // sampling stride for speed
};

/* =========================
   DOM & STATE
   ========================= */
let videoEl, canvasOverlay, ctx;
let startRecBtn, stopRecBtn, loadFileBtn, fileInput, processBtn, slowMoBtn, exportCSVBtn;
let recStateP, blobSizeP, nSamplesSpan, aEstimatedSpan, aTheorySpan, regEquationP, pxToMeterDisplay, rampAngleDisplay;

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let loadedVideoURL = null;

let bgAccumulator = null;  // Float32Array
let bgCount = 0;
let useBackground = false;

let samplesRaw = [];   // {t, x_px, y_px, type}
let samplesFilt = [];  // {t, x_m, y_m, vx, vy}

let pxToMeter = null;  // m/px
let kalman = null;

let slowMotionFactor = 1;

/* Charts */
let posChart = null, velChart = null;

/* =========================
   Matrix helpers for Kalman
   ========================= */
function identity(n, scale = 1) {
  return Array.from({length:n}, (_,i)=>Array.from({length:n},(_,j)=>i===j?scale:0));
}
function transpose(A){ return A[0].map((_,c)=>A.map(r=>r[c])); }
function matMul(A,B){
  const aR=A.length,aC=A[0].length,bC=B[0].length;
  const C=Array.from({length:aR},()=>Array.from({length:bC},()=>0));
  for(let i=0;i<aR;i++){ for(let k=0;k<aC;k++){ const aik=A[i][k]; for(let j=0;j<bC;j++){ C[i][j]+=aik*B[k][j]; } } }
  return C;
}
function addM(A,B){ return A.map((r,i)=>r.map((v,j)=>v+B[i][j])); }
function subM(A,B){ return A.map((r,i)=>r.map((v,j)=>v-B[i][j])); }
function inv2x2(M){
  const [a,b,c,d]=[M[0][0],M[0][1],M[1][0],M[1][1]];
  const det=a*d-b*c;
  if(Math.abs(det)<1e-12) return [[1e12,0],[0,1e12]];
  return [[d/det,-b/det],[-c/det,a/det]];
}

/* =========================
   Kalman 2D (x,vx,y,vy)
   ========================= */
function createKalman(){
  let x = [[0],[0],[0],[0]];
  let P = identity(4,1e3);
  const qPos = 1e-6, qVel = 1e-4;
  const Q = [[qPos,0,0,0],[0,qVel,0,0],[0,0,qPos,0],[0,0,0,qVel]];
  const H = [[1,0,0,0],[0,0,1,0]];
  let R = [[1e-4,0],[0,1e-4]];

  function predict(dt){
    const F = [[1,dt,0,0],[0,1,0,0],[0,0,1,dt],[0,0,0,1]];
    x = matMul(F,x);
    P = addM(matMul(matMul(F,P),transpose(F)),Q);
  }
  function update(z){
    const y_resid = subM(z, matMul(H,x));
    const S = addM(matMul(matMul(H,P),transpose(H)),R);
    const K = matMul(matMul(P,transpose(H)),inv2x2(S));
    x = addM(x, matMul(K,y_resid));
    const I = identity(4);
    const KH = matMul(K,H);
    P = matMul(subM(I,KH),P);
  }
  function setFromMeasurement(z){
    x = [[z[0][0]],[0],[z[1][0]],[0]];
    P = identity(4,1e-1);
  }
  function getState(){ return { x:x[0][0], vx:x[1][0], y:x[2][0], vy:x[3][0] }; }

  return {predict, update, getState, setFromMeasurement};
}

/* =========================
   RGB -> HSV
   ========================= */
function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h=0, s=0, v = max;
  const d = max-min;
  s = max === 0 ? 0 : d/max;
  if(d !== 0){
    if(max === r) h = (g-b)/d + (g<b?6:0);
    else if(max === g) h = (b-r)/d + 2;
    else h = (r-g)/d + 4;
    h *= 60;
  }
  return {h, s, v};
}

/* =========================
   INIT: DOM bindings, start preview
   ========================= */
window.addEventListener("load", () => {
  videoEl = document.getElementById("preview");
  canvasOverlay = document.getElementById("previewCanvas");
  ctx = canvasOverlay.getContext("2d");

  startRecBtn = document.getElementById("startRecBtn");
  stopRecBtn = document.getElementById("stopRecBtn");
  loadFileBtn = document.getElementById("loadFileBtn");
  fileInput = document.getElementById("fileInput");
  processBtn = document.getElementById("processBtn");
  slowMoBtn = document.getElementById("slowMoBtn");
  exportCSVBtn = document.getElementById("exportCSVBtn");

  recStateP = document.getElementById("recState");
  blobSizeP = document.getElementById("blobSize");
  nSamplesSpan = document.getElementById("nSamples");
  aEstimatedSpan = document.getElementById("aEstimated");
  aTheorySpan = document.getElementById("aTheory");
  regEquationP = document.getElementById("regEquation");
  pxToMeterDisplay = document.getElementById("pxToMeterDisplay");
  rampAngleDisplay = document.getElementById("rampAngleDisplay");

  startRecBtn.addEventListener("click", startRecording);
  stopRecBtn.addEventListener("click", stopRecording);
  loadFileBtn.addEventListener("click", ()=> fileInput.click());
  fileInput.addEventListener("change", onFileSelected);
  processBtn.addEventListener("click", processVideo);
  slowMoBtn.addEventListener("click", toggleSlowMo);
  exportCSVBtn.addEventListener("click", exportCSV);

  startPreview();
  initCharts();
});

/* =========================
   Start camera preview and stabilize first-frame black issue
   ========================= */
async function startPreview(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }});
    videoEl.srcObject = stream;
    // ensure video element size and canvas overlay match video
    videoEl.addEventListener("loadedmetadata", () => {
      resizeCanvases();
    });
    // Wait for the first "non-black" frame before drawing overlay
    await waitForFirstNonBlackFrame(videoEl, 1200);
    recStateP.textContent = "État : Preview OK";
    // start preview overlay loop
    requestAnimationFrame(previewLoop);
  }catch(e){
    console.warn("Preview start failed:", e);
    recStateP.textContent = "État : Caméra indisponible";
  }
}

/* resize canvas to video size */
function resizeCanvases(){
  const W = videoEl.videoWidth || 640;
  const H = videoEl.videoHeight || 480;
  canvasOverlay.width = W; canvasOverlay.height = H;
}

/* Wait until the video draws a non-black frame (protect against initial black frames) */
function waitForFirstNonBlackFrame(video, timeoutMs = 1000){
  return new Promise((resolve) => {
    const tmp = document.createElement("canvas");
    const tctx = tmp.getContext("2d");
    const start = performance.now();
    function check(){
      if (video.readyState >= 2) {
        tmp.width = video.videoWidth || 640;
        tmp.height = video.videoHeight || 480;
        tctx.drawImage(video, 0, 0, tmp.width, tmp.height);
        const id = tctx.getImageData(0,0,tmp.width,tmp.height).data;
        let dark = 0, total=0;
        // sample a few pixels
        const step = Math.max(1, Math.floor(tmp.width/40));
        for(let y=0;y<tmp.height;y+=step){
          for(let x=0;x<tmp.width;x+=step){
            const i=(y*tmp.width+x)*4;
            const lum = (id[i]+id[i+1]+id[i+2])/3;
            total++;
            if(lum < 10) dark++;
          }
        }
        const fracDark = dark/total;
        if(fracDark < 0.98){ resolve(); return; } // not all black
      }
      if(performance.now() - start > timeoutMs){ resolve(); return; }
      requestAnimationFrame(check);
    }
    check();
  });
}

/* =========================
   Preview overlay loop: draws detection overlay in realtime on the canvas
   ========================= */
let prevBgForPreview = null; // small running background for preview overlay optional
function previewLoop(){
  if(videoEl.readyState >= 2){
    if(canvasOverlay.width !== videoEl.videoWidth || canvasOverlay.height !== videoEl.videoHeight) resizeCanvases();

    ctx.clearRect(0,0,canvasOverlay.width, canvasOverlay.height);
    // draw detection on preview (fast sampling)
    try{
      // draw current frame to temp canvas then get ImageData
      const tmp = document.createElement("canvas");
      tmp.width = canvasOverlay.width; tmp.height = canvasOverlay.height;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(videoEl, 0, 0, tmp.width, tmp.height);
      const frame = tctx.getImageData(0,0,tmp.width,tmp.height);

      // detect ball or mire quickly for overlay (use stride 4)
      const det = detectBallOrMireQuick(frame);
      if(det){
        // draw circle
        ctx.beginPath();
        ctx.strokeStyle = det.type === "ball" ? "lime" : "cyan";
        ctx.lineWidth = 3;
        ctx.arc(det.x, det.y, 12, 0, Math.PI*2);
        ctx.stroke();
      }
    }catch(e){}
  }
  requestAnimationFrame(previewLoop);
}

/* quick detect for preview overlay (lighter) */
function detectBallOrMireQuick(imgData){
  // reuse detectBallHSV with larger stride
  const b = detectBallHSV(imgData, 6);
  if(b) return b;
  const m = detectMireBW(imgData, 6);
  if(m) return m;
  return null;
}

/* =========================
   Recording handlers
   ========================= */
function startRecording(){
  if(!videoEl.srcObject){ alert("Caméra non initialisée."); return; }
  try{
    mediaRecorder = new MediaRecorder(videoEl.srcObject);
  }catch(e){
    alert("Impossible d'initialiser l'enregistrement : " + e);
    return;
  }
  recordedChunks = [];
  mediaRecorder.ondataavailable = e => { if(e.data && e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
    loadedVideoURL = URL.createObjectURL(recordedBlob);
    blobSizeP.textContent = `Taille vidéo : ${(recordedBlob.size/1024/1024).toFixed(2)} MB`;
    processBtn.disabled = false;
    slowMoBtn.disabled = false;
    recStateP.textContent = "État : Enregistrement terminé";
  };
  mediaRecorder.start();
  recStateP.textContent = "État : Enregistrement...";
  startRecBtn.disabled = true; stopRecBtn.disabled = false;
}
function stopRecording(){
  if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  startRecBtn.disabled = false; stopRecBtn.disabled = true;
}

/* =========================
   File load handler
   ========================= */
function onFileSelected(e){
  const f = e.target.files[0];
  if(!f) return;
  loadedVideoURL = URL.createObjectURL(f);
  blobSizeP.textContent = `Taille vidéo : ${(f.size/1024/1024).toFixed(2)} MB`;
  processBtn.disabled = false; slowMoBtn.disabled = false;
  exportCSVBtn.disabled = true;
}

/* =========================
   PROCESS VIDEO (main pipeline)
   ========================= */
async function processVideo(){
  if(!loadedVideoURL && !videoEl.srcObject){ alert("Aucune source vidéo : enregistre ou charge un fichier."); return; }

  // reset state
  samplesRaw = []; samplesFilt = []; pxToMeter = null; bgAccumulator = null; bgCount = 0; useBackground=false;
  nSamplesSpan.textContent = "0"; aEstimatedSpan.textContent = "—"; aTheorySpan.textContent = "—"; regEquationP.textContent = "Équation : —";
  pxToMeterDisplay.textContent = "Calibration : —"; rampAngleDisplay.textContent = "Angle rampe : —";
  exportCSVBtn.disabled = true;

  // prepare processing video element
  const procVid = document.createElement("video");
  procVid.muted = true; procVid.playsInline = true;
  procVid.width = canvasOverlay.width || 640;
  procVid.height = canvasOverlay.height || 480;
  if(loadedVideoURL) procVid.src = loadedVideoURL;
  else {
    // cannot process live stream reliably here: ask user to record then process
    alert("Traitement en direct non supporté — enregistre et traite le fichier enregistré.");
    return;
  }

  await procVid.play().catch(()=>{});
  await new Promise(r=>setTimeout(r, 120));

  // setup tmp canvas
  const W = procVid.videoWidth || 640;
  const H = procVid.videoHeight || 480;
  canvasOverlay.width = W; canvasOverlay.height = H;
  const tmp = document.createElement("canvas"); tmp.width=W; tmp.height=H;
  const tctx = tmp.getContext("2d");

  // build background average from first N frames
  for(let i=0;i<CONFIG.BG_FRAMES;i++){
    const t = Math.min(procVid.duration || 0, i * (1/30));
    await seekAndDraw(procVid, t, tctx, W, H, (imgData)=>{
      if(!bgAccumulator) bgAccumulator = new Float32Array(imgData.data.length);
      const d = imgData.data;
      for(let k=0;k<d.length;k++) bgAccumulator[k] += d[k];
      bgCount++;
    });
  }
  if(bgCount>0){
    for(let k=0;k<bgAccumulator.length;k++) bgAccumulator[k] /= bgCount;
    useBackground = true;
    console.log("Background estimated from", bgCount, "frames");
  }

  // loop through video by stepping FRAME_STEP_MS
  const stepMs = Math.max(10, CONFIG.FRAME_STEP_MS);
  for(let tMs=0; tMs*0.001 <= (procVid.duration||0) + 0.0001; tMs += stepMs){
    const tSec = tMs * 0.001;
    await seekAndDraw(procVid, tSec, tctx, W, H, (imgData)=>{
      // detection
      const det = detectBallOrMire(imgData, useBackground ? bgAccumulator : null);
      if(det){
        samplesRaw.push({ t: tSec, x_px: det.x, y_px: det.y, type: det.type, diamPx: det.diamPx || null });
        // auto-calibration if ball diameter known
        if(!pxToMeter && det.type === "ball" && det.diamPx && det.diamPx > 2){
          pxToMeter = CONFIG.BALL_REAL_DIAM_M / det.diamPx;
          pxToMeterDisplay.textContent = pxToMeter.toFixed(6) + " m/px";
        }
      }
    });
  }

  if(samplesRaw.length < 3){
    alert("Aucune détection fiable : vérifie l'éclairage, la mire/balle, ou la vidéo.");
    return;
  }

  // sort and apply Kalman smoothing (in metric if pxToMeter known)
  samplesRaw.sort((a,b)=>a.t - b.t);
  kalman = createKalman();
  let kinit=false; let prevT = samplesRaw[0].t;

  for(let i=0;i<samplesRaw.length;i++){
    const s = samplesRaw[i];
    const t = s.t;
    const x_m = pxToMeter ? s.x_px * pxToMeter : s.x_px;
    const y_m = pxToMeter ? s.y_px * pxToMeter : s.y_px;

    if(!kinit){
      kalman.setFromMeasurement([[x_m],[y_m]]);
      kinit = true;
      samplesFilt.push({ t, x: x_m, y: y_m, vx:0, vy:0 });
      prevT = t;
      continue;
    }
    const dt = Math.max(1e-6, t - prevT);
    kalman.predict(dt);
    kalman.update([[x_m],[y_m]]);
    prevT = t;
    const st = kalman.getState();
    samplesFilt.push({ t, x: st.x, y: st.y, vx: Math.round(st.vx*1000)/1000, vy: Math.round(st.vy*1000)/1000 });
  }

  // estimate ramp: PCA
  const ramp = estimateRampAngleAndAxis(samplesFilt);
  rampAngleDisplay.textContent = ramp.angleDeg.toFixed(2) + "°";

  // compute along-ramp coordinate s(t) and fit parabola s(t) -> acceleration
  const sVals = samplesFilt.map(p => {
    const dx = p.x - ramp.cx;
    const dy = p.y - ramp.cy;
    return dx * ramp.ux + dy * ramp.uy;
  });
  const ts = samplesFilt.map(p => p.t);
  const parab = fitParabola(ts, sVals); // returns {a, v0, s0}
  const aEst = parab ? parab.a : NaN;
  aEstimatedSpan.textContent = Number.isFinite(aEst) ? aEst.toFixed(4) : "—";

  const aTheory = 9.81 * Math.sin(ramp.angleDeg * Math.PI/180);
  aTheorySpan.textContent = aTheory.toFixed(4);

  if(parab){
    regEquationP.textContent = `s(t) = ${(parab.a/2).toFixed(4)}·t² + ${parab.v0.toFixed(4)}·t + ${parab.s0.toFixed(4)}`;
  }

  // build charts
  buildCharts(samplesFilt);

  nSamplesSpan.textContent = String(samplesFilt.length);
  exportCSVBtn.disabled = false;
}

/* utility: seek video to time t and call cb(ImageData) */
function seekAndDraw(video, tSec, tctx, W, H, cb){
  return new Promise(res => {
    const onseeked = () => {
      tctx.drawImage(video, 0, 0, W, H);
      const img = tctx.getImageData(0,0,W,H);
      cb(img);
      video.removeEventListener('seeked', onseeked);
      res();
    };
    video.addEventListener('seeked', onseeked);
    try { video.currentTime = Math.min(video.duration || tSec, tSec); }
    catch(e){ video.removeEventListener('seeked', onseeked); res(); }
  });
}

/* =========================
   Combined detection: ball (HSV) OR mire (BW) OR bg-motion
   returns {type, x, y, count, diamPx?}
   ========================= */
function detectBallOrMire(imgData, bgAccum = null){
  const ball = detectBallHSV(imgData, CONFIG.STRIDE);
  const mire = detectMireBW(imgData, CONFIG.STRIDE);
  if(ball && mire){
    const sb = ball.count / CONFIG.MIN_PIXELS_BALL;
    const sm = mire.count / CONFIG.MIN_PIXELS_MIRE;
    return sb >= sm ? ball : mire;
  }
  if(ball) return ball;
  if(mire) return mire;
  if(bgAccum){
    const m = detectMotionByBg(imgData, bgAccum, CONFIG.STRIDE, CONFIG.MOTION_DIFF_THRESHOLD);
    if(m) { m.type = "motion"; return m; }
  }
  return null;
}

/* detect ball via HSV thresholds; returns centroid + count + diamPx */
function detectBallHSV(imgData, stride = 2){
  const data = imgData.data;
  const W = imgData.width, H = imgData.height;
  let sumX=0,sumY=0,count=0;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(let y=0;y<H;y+=stride){
    const row = y*W;
    for(let x=0;x<W;x+=stride){
      const i = (row + x) * 4;
      const r=data[i], g=data[i+1], b=data[i+2];
      const hsv = rgbToHsv(r,g,b);
      if(hsv.h >= CONFIG.HSV.H_MIN && hsv.h <= CONFIG.HSV.H_MAX && hsv.s >= CONFIG.HSV.S_MIN && hsv.v >= CONFIG.HSV.V_MIN){
        sumX += x; sumY += y; count++;
        if(x < minX) minX = x; if(x > maxX) maxX = x;
        if(y < minY) minY = y; if(y > maxY) maxY = y;
      }
    }
  }
  if(count < CONFIG.MIN_PIXELS_BALL) return null;
  const diamPx = Math.max(maxX - minX, maxY - minY);
  return { type: "ball", x: sumX/count, y: sumY/count, count, diamPx };
}

/* detect mire (black/white target) strong dark or bright pixels */
function detectMireBW(imgData, stride = 2){
  const data = imgData.data;
  const W = imgData.width, H = imgData.height;
  let sumX=0,sumY=0,count=0;
  for(let y=0;y<H;y+=stride){
    const row = y*W;
    for(let x=0;x<W;x+=stride){
      const i=(row + x)*4;
      const r=data[i], g=data[i+1], b=data[i+2];
      const lum = (r+g+b)/3;
      if(lum < 40 || lum > 215){
        sumX+=x; sumY+=y; count++;
      }
    }
  }
  if(count < CONFIG.MIN_PIXELS_MIRE) return null;
  return { type:"mire", x: sumX/count, y: sumY/count, count };
}

/* detect motion via background subtraction */
function detectMotionByBg(imgData, bgAccum, stride = 2, threshold = 60){
  const data = imgData.data; const W = imgData.width, H = imgData.height;
  let sumX=0,sumY=0,count=0;
  for(let y=0;y<H;y+=stride){
    const row=y*W;
    for(let x=0;x<W;x+=stride){
      const idx=(row + x)*4;
      const dr = Math.abs(data[idx] - bgAccum[idx]);
      const dg = Math.abs(data[idx+1] - bgAccum[idx+1]);
      const db = Math.abs(data[idx+2] - bgAccum[idx+2]);
      if(dr + dg + db > threshold){
        sumX+=x; sumY+=y; count++;
      }
    }
  }
  if(count < 8) return null;
  return { x: sumX/count, y: sumY/count, count };
}

/* =========================
   Fit parabola s(t) -> returns {a, v0, s0}
   ========================= */
function fitParabola(tArr, sArr){
  const n = tArr.length;
  if(n < 3) return null;
  let S0=0,S1=0,S2=0,S3=0,S4=0;
  let T0=0,T1=0,T2=0;
  for(let i=0;i<n;i++){
    const t=tArr[i], s=sArr[i]; const t2=t*t, t3=t2*t, t4=t3*t;
    S0 += 1; S1 += t; S2 += t2; S3 += t3; S4 += t4;
    T0 += s; T1 += t*s; T2 += t2*s;
  }
  const A = [[S4,S3,S2],[S3,S2,S1],[S2,S1,S0]];
  const B = [T2,T1,T0];
  const sol = solve3x3(A,B);
  if(!sol) return null;
  const Acoef = sol[0], Bcoef = sol[1], Ccoef = sol[2];
  const a = 2 * Acoef;
  return { a, v0: Bcoef, s0: Ccoef };
}

/* Solve 3x3 linear system */
function solve3x3(A,B){
  const M = [A[0].slice(), A[1].slice(), A[2].slice()];
  const b = [B[0], B[1], B[2]];
  for(let i=0;i<3;i++){
    let piv = M[i][i];
    if(Math.abs(piv) < 1e-12){
      let swapped=false;
      for(let r=i+1;r<3;r++){
        if(Math.abs(M[r][i])>1e-12){ [M[i],M[r]]=[M[r],M[i]]; [b[i],b[r]]=[b[r],b[i]]; swapped=true; break; }
      }
      if(!swapped) return null;
      piv = M[i][i];
    }
    for(let j=i;j<3;j++) M[i][j] /= piv;
    b[i] /= piv;
    for(let r=0;r<3;r++){
      if(r===i) continue;
      const f = M[r][i];
      for(let j=i;j<3;j++) M[r][j] -= f * M[i][j];
      b[r] -= f * b[i];
    }
  }
  return b;
}

/* =========================
   Estimate ramp axis via PCA
   returns {angleDeg, ux, uy, cx, cy}
   ========================= */
function estimateRampAngleAndAxis(samples){
  const n = samples.length;
  const xs = samples.map(s=>s.x), ys = samples.map(s=>s.y);
  const cx = xs.reduce((a,b)=>a+b,0)/n;
  const cy = ys.reduce((a,b)=>a+b,0)/n;
  let sxx=0, syy=0, sxy=0;
  for(let i=0;i<n;i++){
    const dx = xs[i]-cx, dy = ys[i]-cy;
    sxx += dx*dx; syy += dy*dy; sxy += dx*dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const trace = sxx + syy;
  const det = sxx*syy - sxy*sxy;
  const lambda1 = trace/2 + Math.sqrt((trace*trace)/4 - det);
  let vx = sxy, vy = lambda1 - sxx;
  if(Math.abs(vx) < 1e-8 && Math.abs(vy) < 1e-8) { vx = 1; vy = 0; }
  const norm = Math.hypot(vx,vy) || 1;
  vx /= norm; vy /= norm;
  const angleDeg = Math.atan2(vy, vx) * 180/Math.PI;
  return { angleDeg, ux: vx, uy: vy, cx, cy };
}

/* =========================
   Charts (Chart.js)
   ========================= */
function initCharts(){
  // placeholder - charts built when data available
}
function buildCharts(samples){
  const t = samples.map(s=>s.t.toFixed(3));
  const xs = samples.map(s=>s.x);
  const ys = samples.map(s=>s.y);
  const vs = samples.map(s=>Math.hypot(s.vx||0,s.vy||0));

  if(posChart) posChart.destroy();
  if(velChart) velChart.destroy();

  posChart = new Chart(document.getElementById("posChart"), {
    type: 'line',
    data: { labels: t, datasets: [
      { label: 'x (m)', data: xs, borderColor: 'blue', fill:false },
      { label: 'y (m)', data: ys, borderColor: 'green', fill:false }
    ]},
    options: { animation:false, responsive:true }
  });

  velChart = new Chart(document.getElementById("velChart"), {
    type: 'line',
    data: { labels: t, datasets: [
      { label: 'v (m/s)', data: vs, borderColor: 'red', fill:false }
    ]},
    options: { animation:false, responsive:true }
  });
}

/* =========================
   Export CSV
   ========================= */
function exportCSV(){
  if(!samplesFilt.length){ alert("Aucune donnée filtrée à exporter."); return; }
  let csv = "t(s),x(m),y(m),vx(m/s),vy(m/s)\n";
  for(const s of samplesFilt) csv += `${s.t},${s.x},${s.y},${s.vx||''},${s.vy||''}\n`;
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = "exAO03_data.csv";
  a.click();
}

/* =========================
   Toggle slow motion label
   ========================= */
function toggleSlowMo(){
  slowMotionFactor = slowMotionFactor === 1 ? 0.4 : 1;
  slowMoBtn.textContent = slowMotionFactor === 1 ? "Ralenti ×1" : "Ralenti ×0.4";
}

/* =========================
   Utility wait
   ========================= */
function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

/* =========================
   Quick detection helpers for preview: reuse heavier functions but with large stride
   ========================= */
function detectBallOrMireQuick(imgData){
  const b = detectBallHSV(imgData, 6);
  if(b) return b;
  const m = detectMireBW(imgData, 6);
  if(m) return m;
  return null;
}

/* =========================
   Utility: detectBallHSV and detectMireBW for preview/process use
   (already defined above in more detailed form) - reuse them
   ========================= */

/* Expose a few functions to console for debugging */
window._exAO = { detectBallOrMireQuick, detectBallHSV, detectMireBW, detectMotionByBg, fitParabola, estimateRampAngleAndAxis };

/* =========================
   End of script
   ========================= */
