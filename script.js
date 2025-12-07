/************************************************************
 * script.js - exAO_02 (version intégrée : MRUA/MRUV/X(t)/CSV)
 ************************************************************/

/* -------------------------
   CONFIG
------------------------- */
const REAL_DIAM_M = 0.15; // 15 cm
const MIN_PIXELS_FOR_DETECT = 40;

/* -------------------------
   STATE
------------------------- */
let recordedChunks = [];
let recordedBlob = null;
let videoURL = null;
let t0_detect = null; // moment où la balle est détectée pour la 1ère fois (temps relatif)
let pxToMeter = null;
let samplesRaw = [];   // {t, x_px, y_px, x_m, y_m}
let samplesFilt = [];  // {t, x, y, vx, vy}
let slowMotionFactor = 1;
let mediaRecorder = null;

/* -------------------------
   DOM
------------------------- */
const preview = document.getElementById("preview");
const previewCanvas = document.getElementById("previewCanvas");
previewCanvas.width = 640; previewCanvas.height = 480;
const ctx = previewCanvas.getContext("2d");

const startBtn = document.getElementById("startRecBtn");
const stopBtn = document.getElementById("stopRecBtn");
const loadBtn = document.getElementById("loadFileBtn");
const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const slowMoBtn = document.getElementById("slowMoBtn");
const frameStepMsInput = document.getElementById("frameStepMs");
const angleInput = document.getElementById("angleInput");
const recStateP = document.getElementById("recState");
const blobSizeP = document.getElementById("blobSize");
const nSamplesSpan = document.getElementById("nSamples");
const aEstimatedSpan = document.getElementById("aEstimated");
const aTheorySpan = document.getElementById("aTheory");
const regEquationP = document.getElementById("regEquation");
const exportCSVBtn = document.getElementById("exportCSVBtn");
const rampAngleDisplay = document.getElementById("rampAngleDisplay"); 

/* Charts */
let posChart = null, velChart = null, fitChart = null;
let doc2Chart = null, doc3Chart = null; // MRU / MRUV charts

/* -------------------------
   UTILITIES: RGB -> HSV
------------------------- */
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (d !== 0) {
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h, s, v };
}

/* -------------------------
   DETECTION BALL
------------------------- */
function detectBall(imgData, stride = 2) {
    const data = imgData.data;
    const W = imgData.width, H = imgData.height;
    let sumX = 0, sumY = 0, count = 0;
    for (let y = 0; y < H; y += stride) {
        for (let x = 0; x < W; x += stride) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const hsv = rgbToHsv(r, g, b);
            const ok = hsv.h >= 28 && hsv.h <= 55 && hsv.s >= 0.22 && hsv.v >= 0.45;
            if (!ok) continue;
            if (r + g + b < 120) continue; // avoid dark spots
            sumX += x; sumY += y; count++;
        }
    }
    if (count < MIN_PIXELS_FOR_DETECT) return null;
    return { x: sumX / count, y: sumY / count, count };
}

/* -------------------------
   CALIBRATION pixels -> meters
------------------------- */
function estimatePxToMeter(imgData) {
    const data = imgData.data;
    const W = imgData.width, H = imgData.height;
    let found = [];
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const hsv = rgbToHsv(r, g, b);
            if (hsv.h >= 28 && hsv.h <= 55 && hsv.s >= 0.22 && hsv.v >= 0.45 && (r+g+b>120)) {
                found.push({ x, y });
            }
        }
    }
    if (found.length < 200) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of found) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const diamPx = Math.max(maxX - minX, maxY - minY);
    if (diamPx <= 2) return null;
    return REAL_DIAM_M / diamPx;
}

/* -------------------------
   KALMAN 2D
------------------------- */
function createKalman() {
    let x = [[0],[0],[0],[0]];
    let P = identity(4,1e3);
    const qPos = 1e-5, qVel = 1e-3;
    let Q = [
        [qPos,0,0,0],
        [0,qVel,0,0],
        [0,0,qPos,0],
        [0,0,0,qVel]
    ];
    const H = [[1,0,0,0],[0,0,1,0]];
    let R = [[1e-6,0],[0,1e-6]];
    function predict(dt) {
        const F = [
            [1,dt,0,0],[0,1,0,0],[0,0,1,dt],[0,0,0,1]
        ];
        x = matMul(F,x);
        P = add(matMul(matMul(F,P),transpose(F)),Q);
    }
    function update(z) {
        const y_resid = sub(z, matMul(H,x));
        const S = add(matMul(matMul(H,P),transpose(H)),R);
        const K = matMul(matMul(P,transpose(H)),inv2x2(S));
        x = add(x, matMul(K,y_resid));
        const I = identity(4);
        const KH = matMul(K,H);
        P = matMul(sub(I,KH),P);
    }
    function setFromMeasurement(z) {
        x = [[z[0][0]],[0],[z[1][0]],[0]];
        P = identity(4,1e-1);
    }
    function getState() { return { x:x[0][0], vx:x[1][0], y:x[2][0], vy:x[3][0] }; }
    return { predict, update, getState, setFromMeasurement };
}

/* MATRIX HELPERS */
function identity(n, scale=1){ return Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=>i===j?scale:0)); }
function transpose(A){ return A[0].map((_,c)=>A.map(r=>r[c])); }
function matMul(A,B){ 
    const aR=A.length, aC=A[0].length, bC=B[0].length; 
    const C=Array.from({length:aR},()=>Array.from({length:bC},()=>0)); 
    for(let i=0;i<aR;i++){ for(let k=0;k<aC;k++){ const aik=A[i][k]; for(let j=0;j<bC;j++){ C[i][j]+=aik*B[k][j]; } } } 
    return C;
}
function add(A,B){ return A.map((r,i)=>r.map((v,j)=>v+B[i][j])); }
function sub(A,B){ return A.map((r,i)=>r.map((v,j)=>v-B[i][j])); }
function inv2x2(M){ const [a,b,c,d]=[M[0][0],M[0][1],M[1][0],M[1][1]]; const det=a*d-b*c; if(Math.abs(det)<1e-12)return [[1e12,0],[0,1e12]]; return [[d/det,-b/det],[-c/det,a/det]]; }

/* -------------------------
   CAMERA PREVIEW
------------------------- */
async function startPreview() {
    try{
        const stream = await navigator.mediaDevices.getUserMedia({video:{width:640,height:480}});
        preview.srcObject = stream;
        setInterval(()=>{
            try{
                ctx.drawImage(preview,0,0,previewCanvas.width,previewCanvas.height);
                const img=ctx.getImageData(0,0,previewCanvas.width,previewCanvas.height);
                const rampPoints = detectRampPoints(img);
                if(rampPoints.length>0){ 
                    const angleDeg = computePrincipalAngleDeg(rampPoints);
                    displayRampAngle(angleDeg);
                }
                const pos = detectBall(img,4);
                if(pos){ ctx.beginPath(); ctx.strokeStyle="lime"; ctx.lineWidth=3; ctx.arc(pos.x,pos.y,12,0,Math.PI*2); ctx.stroke(); }
            }catch(e){}
        },120);
    }catch(e){ console.warn("preview failed", e);}
}
startPreview();

/* -------------------------
   RECORDING HANDLERS
------------------------- */
startBtn.addEventListener("click", async ()=>{
    if(!preview.srcObject){ 
        try{ const s=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480}}); preview.srcObject=s; } 
        catch(e){ alert("Accès caméra refusé"); return;}
    }
    recordedChunks=[];
    try{ mediaRecorder=new MediaRecorder(preview.srcObject,{mimeType:"video/webm;codecs=vp9"});} 
    catch(e){ mediaRecorder=new MediaRecorder(preview.srcObject);}
    mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size) recordedChunks.push(e.data);}
    mediaRecorder.onstop=async ()=>{
        recordedBlob=new Blob(recordedChunks,{type:"video/webm"});
        videoURL=URL.createObjectURL(recordedBlob);
        processBtn.disabled=false; slowMoBtn.disabled=false;
        if(blobSizeP) blobSizeP.textContent=`Vidéo enregistrée (${(recordedBlob.size/1024/1024).toFixed(2)} MB)`;
        try{ processBtn.click(); }catch(e){ console.error("Erreur auto process:", e);}
    };
    mediaRecorder.start();
    recStateP.textContent="État : enregistrement...";
    startBtn.disabled=true; stopBtn.disabled=false;
});

stopBtn.addEventListener("click", ()=>{
    if(mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop();
    recStateP.textContent="État : arrêté";
    startBtn.disabled=false; stopBtn.disabled=true;
});

loadBtn.addEventListener("click",()=>fileInput.click());
fileInput.addEventListener("change",()=>{
    const f=fileInput.files[0];
    if(!f) return;
    recordedBlob=f;
    videoURL=URL.createObjectURL(f);
    processBtn.disabled=false; slowMoBtn.disabled=false;
    if(blobSizeP) blobSizeP.textContent=`Fichier chargé (${(f.size/1024/1024).toFixed(2)} MB)`;
    try{ processBtn.click(); }catch(e){ console.error("auto process load err", e);}
});

/* -------------------------
   PROCESS VIDEO
------------------------- */
processBtn.addEventListener("click", async ()=>{
    if(!videoURL){ alert("Aucune vidéo. Enregistre ou charge un fichier."); return;}
    samplesRaw=[]; samplesFilt=[]; pxToMeter=null; t0_detect=null;
    nSamplesSpan.textContent="0"; aEstimatedSpan.textContent="—"; aTheorySpan.textContent="—"; regEquationP.textContent="Équation : —";
    exportCSVBtn.disabled=true;

    const vid=document.createElement("video");
    vid.src=videoURL; vid.muted=true;

    await new Promise((res,rej)=>{ vid.onloadedmetadata=()=>res(); vid.onerror=e=>rej(e); });

    const stepSec = Math.max(1, Number(frameStepMsInput.value)||10)/1000;
    const kf = createKalman();
    let initialized=false, prevT=null;

    function processFrame(){
        try{
            ctx.drawImage(vid,0,0,previewCanvas.width,previewCanvas.height);
            const img = ctx.getImageData(0,0,previewCanvas.width,previewCanvas.height);

            if(!pxToMeter){ const cal=estimatePxToMeter(img); if(cal){ pxToMeter=cal; const pxDisp=document.getElementById("pxToMeterDisplay"); if(pxDisp) pxDisp.textContent=pxToMeter.toFixed(6)+" m/px";} }

            const pos = detectBall(img,2);
            const absT = vid.currentTime*slowMotionFactor;
            let relT = pos && t0_detect!==null ? absT - t0_detect : null;
            if(pos && t0_detect===null) t0_detect=absT;

            if(pos){
                const x_px=pos.x, y_px=pos.y;
                const x_m = pxToMeter ? x_px*pxToMeter : NaN;
                const y_m = pxToMeter ? y_px*pxToMeter : NaN;
                samplesRaw.push({t:relT, x_px, y_px, x_m, y_m});
                if(pxToMeter && Number.isFinite(x_m) && Number.isFinite(y_m)){
                    const z=[[x_m],[y_m]];
                    if(!initialized){ kf.setFromMeasurement(z); initialized=true; prevT=relT;}
                    else{ const dt=Math.max(1e-6, relT-prevT); kf.predict(dt); kf.update(z); prevT=relT; }
                    const st=kf.getState();
                    samplesFilt.push({t:relT,x:st.x,y:st.y,vx:st.vx,vy:st.vy});

                    ctx.beginPath(); ctx.strokeStyle="rgba(255,0,0,0.7)"; ctx.lineWidth=2; ctx.arc(x_px,y_px,6,0,Math.PI*2); ctx.stroke();
                    const fx_px = pxToMeter ? st.x/pxToMeter : st.x;
                    const fy_px = pxToMeter ? st.y/pxToMeter : st.y;
                    ctx.beginPath(); ctx.strokeStyle="cyan"; ctx.lineWidth=2; ctx.arc(fx_px,fy_px,10,0,Math.PI*2); ctx.stroke();
                    nSamplesSpan.textContent=String(samplesRaw.length);
                }
            }

            if(vid.currentTime + 0.0001 < vid.duration){ vid.currentTime=Math.min(vid.duration, vid.currentTime+stepSec);}
            else{ finalizeAnalysis();}
        }catch(err){ console.error("processFrame error",err); finalizeAnalysis();}
    }
    vid.onseeked=processFrame;
    vid.currentTime=0;
});

/* -------------------------
   FINALIZE ANALYSIS
------------------------- */
function finalizeAnalysis(){
    if(samplesFilt.length<3){ alert("Données insuffisantes après filtrage (vérifie détection / calibration)."); return;}
    const T=samplesFilt.map(s=>s.t);
    const V=samplesFilt.map(s=>Math.hypot(s.vx,s.vy));
    const X=samplesFilt.map(s=>s.x);
    const Y=samplesFilt.map(s=>s.y);

    let num=0, den=0;
    for(let i=0;i<T.length;i++){ if(Number.isFinite(V[i]) && Number.isFinite(T[i])){ num+=T[i]*V[i]; den+=T[i]*T[i];} }
    const aEst = den? num/den : NaN;
    const alphaDeg = Number(angleInput ? angleInput.value : 0) || 0;
    const aTheory = 9.81 * Math.sin(alphaDeg*Math.PI/180);

    aEstimatedSpan.textContent = Number.isFinite(aEst)? aEst.toFixed(4) : "—";
    aTheorySpan.textContent = aTheory.toFixed(4);
    regEquationP.textContent = Number.isFinite(aEst)? `v = ${aEst.toFixed(4)} · t` : "Équation : —";

    buildCharts(samplesFilt, aEst);
    if(alphaDeg===0) buildDoc2_MRU(samplesFilt);
    else buildDoc3_MRUV(samplesFilt);

    exportCSVAuto();
}

/* -------------------------
   RALENTI TOGGLE
------------------------- */
slowMoBtn.addEventListener("click",()=>{
    if(slowMotionFactor===1){ slowMotionFactor=0.25; slowMoBtn.textContent="Ralenti ×1 (normal)"; }
    else{ slowMotionFactor=1; slowMoBtn.textContent="Ralenti ×0.25"; }
});
/* -------------------------
   GRAPHIQUES
------------------------- */
function buildCharts(samples, aEst) {
    const t = samples.map(s=>s.t);
    const x = samples.map(s=>s.x);
    const y = samples.map(s=>s.y);
    const vx = samples.map(s=>s.vx);
    const vy = samples.map(s=>s.vy);

    const posCanvas = document.getElementById("posChartCanvas");
    if(posCanvas){
        const ctxPos = posCanvas.getContext("2d");
        ctxPos.clearRect(0,0,posCanvas.width,posCanvas.height);
        ctxPos.beginPath(); ctxPos.strokeStyle="red"; ctxPos.lineWidth=2;
        for(let i=0;i<t.length;i++){
            const px = i*(posCanvas.width/t.length);
            const py = posCanvas.height - (y[i]/Math.max(...y))*posCanvas.height;
            if(i===0) ctxPos.moveTo(px,py); else ctxPos.lineTo(px,py);
        }
        ctxPos.stroke();
    }

    const velCanvas = document.getElementById("velChartCanvas");
    if(velCanvas){
        const ctxVel = velCanvas.getContext("2d");
        ctxVel.clearRect(0,0,velCanvas.width,velCanvas.height);
        ctxVel.beginPath(); ctxVel.strokeStyle="blue"; ctxVel.lineWidth=2;
        for(let i=0;i<t.length;i++){
            const px = i*(velCanvas.width/t.length);
            const py = velCanvas.height - (Math.hypot(vx[i],vy[i])/Math.max(...vx.concat(vy)))*velCanvas.height;
            if(i===0) ctxVel.moveTo(px,py); else ctxVel.lineTo(px,py);
        }
        ctxVel.stroke();
    }
}

/* MRU / MRUV documents */
function buildDoc2_MRU(samples){
    // MRU : vitesse constante sur axe ramp
    const t = samples.map(s=>s.t);
    const x = samples.map(s=>s.x);
    console.log("MRU document:", t.length, "samples", x.length, "positions");
    // ici on peut générer graphique supplémentaire ou tableau HTML
}

function buildDoc3_MRUV(samples){
    // MRUV : accélération non nulle
    const t = samples.map(s=>s.t);
    const y = samples.map(s=>s.y);
    console.log("MRUV document:", t.length, "samples", y.length, "positions");
    // ici on peut générer graphique supplémentaire ou tableau HTML
}

/* -------------------------
   RAMPE / ANGLE DYNAMIQUE
------------------------- */
function detectRampPoints(imgData){
    // placeholder : retourne un tableau de points {x,y} de la rampe
    // peut être basé sur couleur ou luminosité
    return []; 
}

function computePrincipalAngleDeg(points){
    if(points.length<2) return 0;
    const x0=points[0].x, y0=points[0].y;
    const x1=points[points.length-1].x, y1=points[points.length-1].y;
    const angleRad = Math.atan2(y1-y0, x1-x0);
    return angleRad*180/Math.PI;
}

function displayRampAngle(angleDeg){
    if(rampAngleDisplay) rampAngleDisplay.textContent = `Angle rampe : ${angleDeg.toFixed(2)}°`;
}

/* -------------------------
   EXPORT CSV
------------------------- */
exportCSVBtn.addEventListener("click", ()=>exportCSVAuto());
function exportCSVAuto(){
    if(!samplesFilt.length){ console.warn("Aucune donnée filtrée : CSV non généré."); return; }
    const alphaDeg = Number(angleInput?angleInput.value:0)||0;
    const aTheory = 9.8 * Math.sin(alphaDeg*Math.PI/180);
    const y0 = samplesFilt[0].y; const x0 = samplesFilt[0].x;
    let csv="t(s),x(m),y(m),vx(m/s),vy(m/s),aTheory(m/s²)\n";
    for(const s of samplesFilt){ csv+=`${s.t},${s.x},${s.y},${s.vx},${s.vy},${aTheory}\n`; }
    const blob = new Blob([csv],{type:"text/csv"});
    const a = document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download="data.csv"; a.click();
    exportCSVBtn.disabled=false;
}

/************************************************************
 * Fonctions placeholders à compléter selon exAO existant :
 * buildCharts(samples,aEst)
 * buildDoc2_MRU(samples)
 * buildDoc3_MRUV(samples)
 * detectRampPoints(imgData)
 * computePrincipalAngleDeg(points)
 * displayRampAngle(angleDeg)
 ************************************************************/
