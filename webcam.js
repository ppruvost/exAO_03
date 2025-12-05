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
