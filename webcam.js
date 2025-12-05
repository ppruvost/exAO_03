/* -------------------------
webcam.js
Responsabilités :
 - accès caméra (USB / device selection)
 - preview + overlay de détection (mire de Foucault / mobile)
 - calibration px <-> m (diamètre connu de la mire)
 - mise au point / estimation de l'angle du plan incliné à partir de la mire (PCA simple)
 - expose une interface globale `WebcamModule` pour être utilisée par script.js

ATTENTION : Ce fichier ne gère PAS l'enregistrement ni l'analyse des données. Il expose uniquement l'accès vidéo, la détection et la calibration.
*/

const WebcamModule = (function(){
  const REAL_DIAM_M = 0.15; // diamètre réel de la mire (m) - ajuster si besoin
  const MIN_PIXELS_FOR_DETECT = 40;

  // DOM
  let preview = null; // element video
  let previewCanvas = null; let ctx = null;

  // state
  let stream = null;
  let pxToMeter = null;
  let overlayInterval = null;

  // utilities
  function rgbToHsv(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0,s=0,v=max; const d=max-min; s = max===0?0:d/max; if(d!==0){ if(max===r) h=(g-b)/d + (g<b?6:0); else if(max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60;} return {h,s,v}; }

  function detectMire(imgData, stride=2){
    // détecte la mire (couleur claire ocre) - retourne centroid + pixels list
    const data = imgData.data; const W=imgData.width, H=imgData.height;
    let sumX=0,sumY=0,count=0; let pixels=[];
    for(let y=0;y<H;y+=stride){
      for(let x=0;x<W;x+=stride){
        const i=(y*W+x)*4; const r=data[i], g=data[i+1], b=data[i+2];
        const hsv = rgbToHsv(r,g,b);
        const ok = hsv.h >= 18 && hsv.h <= 60 && hsv.s >= 0.12 && hsv.v >= 0.35; // paramètres larges
        if(!ok) continue; if (r+g+b<120) continue;
        sumX += x; sumY += y; count++; pixels.push({x,y});
      }
    }
    if (count < MIN_PIXELS_FOR_DETECT) return null;
    return { x: sumX/count, y: sumY/count, count, pixels };
  }

  function estimatePxToMeterFromPixels(pixels){
    if(!pixels || pixels.length<200) return null;
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for(const p of pixels){ if(p.x<minX) minX=p.x; if(p.x>maxX) maxX=p.x; if(p.y<minY) minY=p.y; if(p.y>maxY) maxY=p.y; }
    const diamPx = Math.max(maxX-minX, maxY-minY);
    if(diamPx<=2) return null;
    return REAL_DIAM_M / diamPx;
  }

  function pcaAngle(pixels){
    // calcul simplifié de l'orientation principale (en radians) via covariance
    if(!pixels||pixels.length<10) return null;
    let meanX=0, meanY=0; for(const p of pixels){ meanX+=p.x; meanY+=p.y; } meanX/=pixels.length; meanY/=pixels.length;
    let Sxx=0,Syy=0,Sxy=0; for(const p of pixels){ const dx=p.x-meanX, dy=p.y-meanY; Sxx+=dx*dx; Syy+=dy*dy; Sxy+=dx*dy; }
    // angle = 0.5 * atan2(2Sxy, Sxx - Syy) gives principal component direction
    const ang = 0.5 * Math.atan2(2*Sxy, Sxx - Syy);
    return ang; // radians, relative à l'horizontale (px)
  }

  /* -------------------------
     Preview control
     ------------------------- */
  async function init({videoElId="preview", canvasId="previewCanvas", width=640, height=480}={}){
    preview = document.getElementById(videoElId);
    previewCanvas = document.getElementById(canvasId);
    if(!preview || !previewCanvas) throw new Error("Elements DOM manquants: video/canvas");
    previewCanvas.width = width; previewCanvas.height = height;
    ctx = previewCanvas.getContext('2d');

    // attempt to get user media (list devices if possible)
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video: { width, height } });
      preview.srcObject = stream; preview.play();
    }catch(e){
      console.error("Impossible d'accéder à la caméra",e); throw e;
    }

    // start overlay loop
    overlayInterval = setInterval(()=>{
      try{
        ctx.drawImage(preview,0,0,previewCanvas.width, previewCanvas.height);
        const img = ctx.getImageData(0,0,previewCanvas.width, previewCanvas.height);
        const det = detectMire(img, 3);
        if(det){
          // draw centroid
          ctx.beginPath(); ctx.strokeStyle='lime'; ctx.lineWidth=3; ctx.arc(det.x, det.y, 12,0,Math.PI*2); ctx.stroke();
        }
      }catch(err){ /* ignore */ }
    }, 120);
  }

  function stopPreview(){ if(overlayInterval) clearInterval(overlayInterval); if(stream){ for(const t of stream.getTracks()) t.stop(); stream=null; } }

  function getStream(){ return stream; }

  /* -------------------------
     API utilities pour script.js
     ------------------------- */
  async function detectOnce(){
    if(!ctx || !preview) throw new Error("Module non initialisé");
    ctx.drawImage(preview,0,0,previewCanvas.width, previewCanvas.height);
    const img = ctx.getImageData(0,0,previewCanvas.width, previewCanvas.height);
    const det = detectMire(img, 2);
    if(!det) return null;
    const est = estimatePxToMeterFromPixels(det.pixels);
    if(est) pxToMeter = est;
    const angleRad = pcaAngle(det.pixels);
    const angleDeg = angleRad !== null ? angleRad * 180/Math.PI : null;
    return { centroid: {x: det.x, y: det.y}, pxToMeter, angleRad, angleDeg, count: det.count };
  }

  function getPxToMeter(){ return pxToMeter; }
  function setRealDiamMeters(m){ if(typeof m==='number' && m>0) REAL_DIAM_M = m; }

  // expose a convenience function that will auto-calibrate and estimate angle by sampling a few frames
  async function autoCalibrateAndAngle(samples=8, delayMs=150){
    const results = [];
    for(let i=0;i<samples;i++){
      const r = await detectOnce(); if(r) results.push(r);
      await new Promise(res=>setTimeout(res, delayMs));
    }
    // pick best (most pixels) for pxToMeter
    if(results.length===0) return null;
    results.sort((a,b)=> (b.count||0)-(a.count||0));
    if(results[0].pxToMeter) pxToMeter = results[0].pxToMeter;
    // angle median
    const angles = results.map(r=>r.angleRad).filter(a=>a!==null);
    let medianAngle = null;
    if(angles.length){ angles.sort((a,b)=>a-b); medianAngle = angles[Math.floor(angles.length/2)]; }
    return { pxToMeter, angleRad: medianAngle, angleDeg: medianAngle!==null ? medianAngle*180/Math.PI : null };
  }

  /* return interface */
  return { init, stopPreview, getStream, detectOnce, autoCalibrateAndAngle, getPxToMeter };
})();

// expose global for easy inclusion
window.WebcamModule = WebcamModule;


/* -------------------------
script.js
Responsabilités :
 - enregistrement vidéo en .mp4 si possible (sinon propose fallback webm)
 - traitement frame-by-frame avec prise de points à 1/10 s (0.1s)
 - génération de 2 graphiques :
    1) vitesse (cm / 0.1s) en fonction du temps (en 0.1s) + droite de régression linéaire (équation affichée)
    2) position du mobile (mire) en cm en fonction du temps (0.1s) + courbe de régression quadratique (équation affichée)
 - export CSV
 - suppresion des anciens graphiques inutiles

ATTENTION : Ce fichier suppose que webcam.js a déjà été chargé et initialisé (WebcamModule.init(...)).
*/

(function(){
  // DOM attendus
  const startBtn = document.getElementById('startRecBtn');
  const stopBtn = document.getElementById('stopRecBtn');
  const processBtn = document.getElementById('processBtn');
  const exportCSVBtn = document.getElementById('exportCSVBtn');
  const frameStepMsInput = document.getElementById('frameStepMs'); // ceci sera ignoré: on force 100ms
  const pxToMeterDisplay = document.getElementById('pxToMeterDisplay');
  const regEquationP = document.getElementById('regEquation');
  const regPositionP = document.getElementById('regPosition');

  const posCanvas = document.getElementById('posChart');
  const velCanvas = document.getElementById('velChart');

  let mediaRecorder = null; let recordedChunks = []; let recordedBlob = null; let videoURL = null;
  let samplesRaw = []; let samplesFilt = []; let pxToMeter = null;

  let posChart=null, velChart=null;

  // Enregistrement : tenter mp4, fallback webm
  startBtn && startBtn.addEventListener('click', async ()=>{
    try{
      const s = WebcamModule.getStream();
      if(!s){ alert('La caméra n\'est pas disponible. Initialisez WebcamModule.'); return; }
      recordedChunks=[];
      try{ mediaRecorder = new MediaRecorder(s, { mimeType: 'video/mp4;codecs=h264' }); }
      catch(e){ try{ mediaRecorder = new MediaRecorder(s, { mimeType: 'video/webm;codecs=vp9' }); }catch(e2){ mediaRecorder = new MediaRecorder(s); } }
      mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = ()=>{
        recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
        videoURL = URL.createObjectURL(recordedBlob);
        alert('Enregistrement terminé. Format: '+recordedBlob.type);
        processBtn.disabled = false; exportCSVBtn.disabled = false;
      };
      mediaRecorder.start(); startBtn.disabled=true; stopBtn.disabled=false;
    }catch(err){ console.error(err); alert('Impossible de démarrer l\'enregistrement: '+err.message); }
  });

  stopBtn && stopBtn.addEventListener('click', ()=>{
    if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); startBtn.disabled=false; stopBtn.disabled=true;
  });

  // traitement à 0.1s (1/10s)
  processBtn && processBtn.addEventListener('click', async ()=>{
    if(!videoURL && !recordedBlob){ alert('Aucune vidéo disponible. Enregistrez ou chargez une vidéo.'); return; }
    samplesRaw=[]; samplesFilt=[]; pxToMeter = WebcamModule.getPxToMeter(); if(pxToMeterDisplay) pxToMeterDisplay.textContent = pxToMeter ? pxToMeter.toFixed(6)+' m/px' : 'non calibré';

    const vid = document.createElement('video'); vid.src = videoURL || URL.createObjectURL(recordedBlob); vid.muted = true;
    await new Promise((res,rej)=>{ vid.onloadedmetadata = ()=> res(); vid.onerror = e=> rej(e); });

    const stepSec = 0.1; // 1/10 s sampling

    // simple Kalman comme avant
    const kf = createKalman(); let initialized=false; let prevT=null;

    function processFrame(){
      try{
        const canvas = document.getElementById('previewCanvas'); const ctx = canvas.getContext('2d');
        ctx.drawImage(vid,0,0,canvas.width, canvas.height);
        const img = ctx.getImageData(0,0,canvas.width, canvas.height);
        const det = detectBall(img, 2); // réutilise detectBall défini précédemment dans webcam.js scope global si présent
        const absT = vid.currentTime;
        if(det){
          const x_px = det.x, y_px = det.y;
          const x_m = pxToMeter ? x_px * pxToMeter : NaN;
          const y_m = pxToMeter ? y_px * pxToMeter : NaN;
          const relT = (samplesRaw.length===0) ? 0 : (samplesRaw[samplesRaw.length-1].t + stepSec);
          samplesRaw.push({t: relT, x_px, y_px, x_m, y_m});

          if(pxToMeter && Number.isFinite(x_m) && Number.isFinite(y_m)){
            const z = [[x_m],[y_m]];
            if(!initialized){ kf.setFromMeasurement(z); initialized=true; prevT=relT; }
            else{ const dt = Math.max(1e-6, relT - prevT); kf.predict(dt); kf.update(z); prevT = relT; }
            const st = kf.getState(); samplesFilt.push({t: relT, x: st.x, y: st.y, vx: st.vx, vy: st.vy});
          }
        } else {
          // add null sample if needed to keep uniform sampling
          const relT = (samplesRaw.length===0) ? 0 : (samplesRaw[samplesRaw.length-1].t + stepSec);
          samplesRaw.push({t: relT, x_px: NaN, y_px: NaN, x_m: NaN, y_m: NaN});
        }

        // advance video time
        if(vid.currentTime + 0.0001 < vid.duration) vid.currentTime = Math.min(vid.duration, vid.currentTime + stepSec);
        else { finalizeAnalysis(); return; }
      }catch(err){ console.error('processFrame',err); finalizeAnalysis(); }
    }

    vid.onseeked = processFrame; vid.currentTime = 0;

    function finalizeAnalysis(){
      if(samplesFilt.length<3){ alert('Données filtrées insuffisantes.'); return; }

      // convertir en cm et unités demandées
      // temps en unités 0.1s (on garde en secondes mais les labels seront en 0.1s)
      const T = samplesFilt.map(s=>s.t); // s en s
      const posCm = samplesFilt.map(s=> s.y * 100 ); // position en cm (on prend y comme direction du mobile)
      const vel_m_s = samplesFilt.map(s=> Math.hypot(s.vx, s.vy) );
      // vitesse demandée : cm / 0.1s -> convert m/s -> cm per 0.1s = (m/s)*100 * 0.1 = (m/s)*10
      const vel_c_per_0p1s = vel_m_s.map(v=> v * 10);

      // regression linéaire v = a * t + b (on affiche équation)
      function linearFit(X,Y){ const n=X.length; let Sx=0,Sy=0,Sxx=0,Sxy=0; for(let i=0;i<n;i++){ Sx+=X[i]; Sy+=Y[i]; Sxx+=X[i]*X[i]; Sxy+=X[i]*Y[i]; } const denom = n*Sxx - Sx*Sx; if(Math.abs(denom)<1e-12) return {a:0,b:0}; const a=(n*Sxy - Sx*Sy)/denom; const b=(Sy - a*Sx)/n; return {a,b}; }

      const fitV = linearFit(T, vel_c_per_0p1s);
      const fitV_line = T.map(t => fitV.a * t + fitV.b);

      // regression quadratique for position: y = A t^2 + B t + C
      function quadFit(Tarr, Yarr){ const n=Tarr.length; let S0=n, S1=0,S2=0,S3=0,S4=0; let SY=0, STY=0, ST2Y=0; for(let i=0;i<n;i++){ const t=Tarr[i], y=Yarr[i], t2=t*t; S1+=t; S2+=t2; S3+=t2*t; S4+=t2*t2; SY+=y; STY+=t*y; ST2Y+=t2*y; } const M=[[S4,S3,S2],[S3,S2,S1],[S2,S1,S0]]; const V=[ST2Y, STY, SY]; function solve3(M,V){ const [a,b,c]=M[0]; const [d,e,f]=M[1]; const [g,h,i]=M[2]; const det = a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g); if(Math.abs(det)<1e-12) return [0,0,0]; const Dx = (V[0]*(e*i - f*h) - b*(V[1]*i - f*V[2]) + c*(V[1]*h - e*V[2])); const Dy = (a*(V[1]*i - f*V[2]) - V[0]*(d*i - f*g) + c*(d*V[2] - V[1]*g)); const Dz = (a*(e*V[2] - V[1]*h) - b*(d*V[2] - V[1]*g) + V[0]*(d*h - e*g)); return [Dx/det, Dy/det, Dz/det]; }
      const [A,B,C] = solve3(M,V); const fitPos = T.map(t => A*t*t + B*t + C);

      // build charts
      buildVelocityChart(T, vel_c_per_0p1s, fitV_line, fitV);
      buildPositionChart(T, posCm, fitPos, {A,B,C});

      // show equations
      regEquationP && (regEquationP.textContent = `Vitesse (cm / 0.1s) = ${fitV.a.toFixed(4)} · t + ${fitV.b.toFixed(4)}`);
      regPositionP && (regPositionP.textContent = `Position (cm) = ${A.toFixed(4)}·t² + ${B.toFixed(4)}·t + ${C.toFixed(4)}`);

      exportCSVBtn.disabled = false;
    }
  });

  function buildVelocityChart(T, V, fitLine, fitParams){
    const labels = T.map(t => (t*10).toFixed(1)); // afficher temps en unités de 1/10s (ex: t[s]*10 donne nombre de 0.1s)
    if(velChart) velChart.destroy();
    velChart = new Chart(velCanvas, {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Vitesse (cm / 0.1s)', data: T.map((t,i)=>({x:t, y: V[i]})), pointRadius:3 },
          { label: 'Régression linéaire', data: T.map(t=>({x:t, y: fitParams.a*t + fitParams.b})), type:'line', fill:false }
        ]
      },
      options: {
        parsing: false,
        scales: {
          x: { type:'linear', title:{display:true, text:'t (s)'} },
          y: { title:{display:true, text:'v (cm / 0.1s)'} }
        }
      }
    });
  }

  function buildPositionChart(T, posCm, fitPos, coeffs){
    if(posChart) posChart.destroy();
    posChart = new Chart(posCanvas, {
      type: 'line',
      data: {
        labels: T,
        datasets: [
          { label: 'Position (cm)', data: posCm, fill:false, pointRadius:3 },
          { label: 'Fit quadratique', data: fitPos, type:'line', fill:false, borderDash:[6,4], pointRadius:0 }
        ]
      },
      options: {
        scales: { x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'position (cm)'} } }
      }
    });
  }

  // export CSV (filtered samples): on export, we recompute arrays from samplesFilt
  exportCSVBtn && exportCSVBtn.addEventListener('click', ()=>{
    if(!samplesFilt.length) { alert('Aucune donnée filtrée à exporter.'); return; }
    const header = ['t(s)','x(m)','y(m)','vx(m/s)','vy(m/s)'];
    const rows = samplesFilt.map(s => [s.t.toFixed(4), s.x.toFixed(6), s.y.toFixed(6), s.vx.toFixed(6), s.vy.toFixed(6)].join(','));
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'data_filtered.csv'; document.body.appendChild(a); a.click(); a.remove();
  });

  // expose small helper (re-uses Kalman matrix helpers defined earlier in the original script)
  function createKalman(){
    let x = [[0],[0],[0],[0]]; let P = identity(4,1e3);
    const qPos=1e-5, qVel=1e-3; let Q = [[qPos,0,0,0],[0,qVel,0,0],[0,0,qPos,0],[0,0,0,qVel]];
    const H = [[1,0,0,0],[0,0,1,0]]; let R = [[1e-6,0],[0,1e-6]];
    function predict(dt){ const F=[[1,dt,0,0],[0,1,0,0],[0,0,1,dt],[0,0,0,1]]; x=matMul(F,x); P=add(matMul(matMul(F,P),transpose(F)), Q); }
    function update(z){ const y_resid = sub(z, matMul(H,x)); const S = add(matMul(matMul(H,P),transpose(H)), R); const K = matMul(matMul(P, transpose(H)), inv2x2(S)); x = add(x, matMul(K, y_resid)); const I=identity(4); const KH = matMul(K,H); P = matMul(sub(I,KH),P); }
    function setFromMeasurement(z){ x=[[z[0][0]],[0],[z[1][0]],[0]]; P=identity(4,1e-1); }
    function getState(){ return { x:x[0][0], vx:x[1][0], y:x[2][0], vy:x[3][0] }; }
    return { predict, update, getState, setFromMeasurement };
  }

  // matrix helpers (copiés depuis script d'origine)
  function identity(n, scale=1){ return Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=> i===j?scale:0)); }
  function transpose(A){ return A[0].map((_,c)=>A.map(r=>r[c])); }
  function matMul(A,B){ const aR=A.length, aC=A[0].length, bC=B[0].length; const C = Array.from({length:aR}, ()=>Array.from({length:bC}, ()=>0)); for(let i=0;i<aR;i++){ for(let k=0;k<aC;k++){ const aik=A[i][k]; for(let j=0;j<bC;j++){ C[i][j] += aik * B[k][j]; } } } return C; }
  function add(A,B){ return A.map((row,i)=>row.map((v,j)=>v + B[i][j])); }
  function sub(A,B){ return A.map((row,i)=>row.map((v,j)=>v - B[i][j])); }
  function inv2x2(M){ const a=M[0][0], b=M[0][1], c=M[1][0], d=M[1][1]; const det = a*d - b*c; if(Math.abs(det)<1e-12) return [[1e12,0],[0,1e12]]; return [[d/det, -b/det], [-c/det, a/det]]; }

})();

/* -------------------------
Note:
- Ce paire de fichiers suppose que Chart.js est chargé dans la page.
- Les fonctions detectBall/estimatePxToMeter et helpers de matrice sont dupliquées localement pour éviter les dépendances circulaires. Si vous préférez centraliser, adaptez en conséquence.
- Le stockage en .mp4 dépend du support du navigateur (souvent limité). Le code tente d'initialiser MediaRecorder en mp4 (H.264) puis revient sur webm si indisponible.

Inclure dans le HTML :
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="webcam.js"></script>
<script src="script.js"></script>

*/
