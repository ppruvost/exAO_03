/* Script d'analyse Mire de Foucault — version améliorée
   Méthodes implémentées :
   - pré-traitement (grayscale, blur)
   - détection de contours (Sobel)
   - Hough Circle (accumulateur optimisé pour plage de rayons)
   - profil radial + DFT (analyse FFT du motif radial)
   - adaptation aux petites résolutions (downscale automatique)
   - API : detectBestCircle(video) -> {cx,cy,r,score,mmPerPixel,radialFFT}
*/

const MIRE_DIAMETER_MM = 85;           // diamètre réel
const EXPECTED_DIAM_PX_UI = 322;      // diamètre affiché UI

// paramètres de performance
const MAX_PROC_WIDTH = 480; // downscale to this width for faster processing on mobile

// utilitaires image
function toGrayscale(imgData){
  const w = imgData.width, h = imgData.height; const src = imgData.data;
  const out = new Uint8ClampedArray(w*h);
  for(let i=0, j=0;i<src.length;i+=4, j++){
    // luminosity method
    out[j] = (0.299*src[i] + 0.587*src[i+1] + 0.114*src[i+2])|0;
  }
  return {data: out, width: w, height: h};
}

function boxBlur(gray, radius=1){
  const w=gray.width, h=gray.height; const src=gray.data; const out=new Uint8ClampedArray(w*h);
  const k = radius*2+1; const area = k*k;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let sum=0;
      for(let dy=-radius; dy<=radius; dy++){
        const yy = Math.min(h-1, Math.max(0, y+dy));
        for(let dx=-radius; dx<=radius; dx++){
          const xx = Math.min(w-1, Math.max(0, x+dx));
          sum += src[yy*w + xx];
        }
      }
      out[y*w + x] = (sum/area)|0;
    }
  }
  return {data: out, width:w, height:h};
}

function sobelMagnitude(gray){
  const w=gray.width, h=gray.height, src=gray.data; const out=new Float32Array(w*h);
  const gx=[-1,0,1,-2,0,2,-1,0,1]; const gy=[-1,-2,-1,0,0,0,1,2,1];
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let sx=0, sy=0, k=0;
      for(let j=-1;j<=1;j++){
        for(let i=-1;i<=1;i++){ const v = src[(y+j)*w + (x+i)]; sx += v * gx[k]; sy += v * gy[k]; k++; }
      }
      out[y*w + x] = Math.hypot(sx, sy);
    }
  }
  return {data: out, width:w, height:h};
}

// simple threshold to edge binary map
function edgeBinary(sobel, thresh){
  const w=sobel.width, h=sobel.height, src=sobel.data; const out = new Uint8ClampedArray(w*h);
  for(let i=0;i<w*h;i++) out[i] = src[i] >= thresh ? 1 : 0;
  return {data: out, width:w, height:h};
}

// Hough Circle accumulator (optimized): search for center accumulator for a set of radii
function houghCircle(edges, rMin, rMax, stepR=2, stepThetaDeg=8, votesThresholdFactor=0.5){
  const w=edges.width, h=edges.height, data=edges.data;
  const cxAcc = new Int32Array(w*h); // accumulator for centers (we'll reuse across radii)
  let best = null;

  // precompute sin/cos for theta sampling
  const thetaStep = stepThetaDeg * Math.PI/180;
  const thetas = [];
  for(let t=0;t<Math.PI*2; t+=thetaStep) thetas.push({c:Math.cos(t), s:Math.sin(t)});

  // collect edge points
  const edgePoints = [];
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      if(data[y*w + x]) edgePoints.push({x,y});
    }
  }
  if(edgePoints.length === 0) return null;

  // loop radii
  for(let r=rMin; r<=rMax; r+=stepR){
    // zero accumulator
    cxAcc.fill(0);
    const rFloat = r;
    // for each edge, vote centers
    for(const p of edgePoints){
      const x0=p.x, y0=p.y;
      for(const t of thetas){
        const a = Math.round(x0 - rFloat * t.c);
        const b = Math.round(y0 - rFloat * t.s);
        if(a>=0 && a<w && b>=0 && b<h){ cxAcc[b*w + a]++; }
      }
    }
    // find max in accumulator
    let localMax = 0, idxMax = -1;
    for(let i=0;i<w*h;i++){
      const v = cxAcc[i]; if(v>localMax){ localMax=v; idxMax=i; }
    }
    const votes = localMax;
    // heuristic threshold: must have a reasonable portion of perimeter votes
    const perimeterVotesPossible = thetas.length * (edgePoints.length / (w*h) * 4); // rough
    const threshold = Math.max(8, Math.floor(thetas.length * votesThresholdFactor));

    if(votes >= threshold){
      const cy = Math.floor(idxMax / w), cxVal = idxMax % w;
      const score = votes / thetas.length; // 0..1-ish
      // refine by local search radius
      if(!best || score > best.score){ best = {cx:cxVal, cy, r, votes, score}; }
    }
  }
  return best;
}

// radial profile around candidate center
function radialProfile(gray, cx, cy, radiusPx, nAngles=360){
  const w=gray.width, h=gray.height, img=gray.data;
  const profile = new Float32Array(nAngles);
  for(let a=0;a<nAngles;a++){
    const theta = (a / nAngles) * 2*Math.PI;
    const rx = Math.cos(theta), ry = Math.sin(theta);
    // sample along a narrow annulus near radiusPx (average of few samples)
    const samples = 6; let sum=0; let count=0;
    for(let s=-2;s<=3;s++){
      const r = radiusPx + s;
      const x = Math.round(cx + r * rx), y = Math.round(cy + r * ry);
      if(x>=0 && x<w && y>=0 && y<h){ sum += img[y*w + x]; count++; }
    }
    profile[a] = count? sum/count : 0;
  }
  return profile;
}

// simple DFT (sufficient for <= 1024 length)
function dftReal(profile){
  const N = profile.length; const re = new Float32Array(N); const im = new Float32Array(N);
  for(let k=0;k<N;k++){
    let sumRe=0, sumIm=0;
    for(let n=0;n<N;n++){
      const ang = -2*Math.PI*k*n / N; const c=Math.cos(ang), s=Math.sin(ang);
      sumRe += profile[n]*c; sumIm += profile[n]*s;
    }
    re[k]=sumRe; im[k]=sumIm;
  }
  // magnitude
  const mag = new Float32Array(N/2);
  for(let k=0;k<N/2;k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

// main detection pipeline
async function detectBestCircleFromVideoFrame(video){
  // create temp canvas scaled to MAX_PROC_WIDTH
  const temp = document.createElement('canvas');
  const scale = Math.min(1, MAX_PROC_WIDTH / video.videoWidth);
  temp.width = Math.max(64, Math.floor(video.videoWidth * scale));
  temp.height = Math.max(64, Math.floor(video.videoHeight * scale));
  const ctx = temp.getContext('2d');
  ctx.drawImage(video, 0, 0, temp.width, temp.height);

  const imgData = ctx.getImageData(0,0,temp.width,temp.height);
  const gray = toGrayscale(imgData);
  const blur = boxBlur(gray, 1);
  const sob = sobelMagnitude(blur);

  // pick threshold as fraction of max gradient
  let maxG = 0; for(let i=0;i<sob.data.length;i++) if(sob.data[i]>maxG) maxG = sob.data[i];
  const edge = edgeBinary(sob, Math.max(12, maxG * 0.25));

  // expected radius in proc-px (we know UI px but need to scale)
  const expectedDiamProc = EXPECTED_DIAM_PX_UI * (temp.width / document.documentElement.clientWidth || 1);
  // fallback: use image diag fraction
  const diag = Math.hypot(temp.width, temp.height);
  const guessDiam = Math.min(temp.width*0.6, Math.max(20, diag*0.35));
  const d = Math.floor(guessDiam);

  const rMin = Math.max(6, Math.floor(d*0.6/2));
  const rMax = Math.max(rMin+2, Math.floor(d*1.4/2));

  const best = houghCircle(edge, rMin, rMax, 2, 6, 0.4);
  if(!best) return null;

  // compute radial profile on higher-res original video frame for accuracy
  // compute mapping from proc coords to video coords
  const scaleX = video.videoWidth / temp.width; const scaleY = video.videoHeight / temp.height;
  const cxHigh = Math.round(best.cx * scaleX); const cyHigh = Math.round(best.cy * scaleY);
  const rHigh = Math.round(best.r * ((scaleX + scaleY)/2));

  // draw concentric overlay on main overlay canvas if exists
  const overlayCanvas = document.getElementById('mireOverlay');
  if(overlayCanvas){ overlayCanvas.width = video.videoWidth; overlayCanvas.height = video.videoHeight; const octx = overlayCanvas.getContext('2d'); octx.clearRect(0,0,overlayCanvas.width, overlayCanvas.height); octx.strokeStyle = 'rgba(0,200,120,0.8)'; octx.lineWidth = Math.max(2, Math.round(2 * (video.videoWidth/640)));
    octx.beginPath(); octx.arc(cxHigh, cyHigh, rHigh, 0, Math.PI*2); octx.stroke(); // best circle
    // rings
    for(let k=1;k<=3;k++){ octx.beginPath(); octx.arc(cxHigh, cyHigh, Math.round(rHigh * (k/3)), 0, Math.PI*2); octx.stroke(); }
    // crosshair
    octx.beginPath(); octx.moveTo(cxHigh - rHigh, cyHigh); octx.lineTo(cxHigh + rHigh, cyHigh); octx.moveTo(cxHigh, cyHigh - rHigh); octx.lineTo(cxHigh, cyHigh + rHigh); octx.stroke(); }

  // sample radial profile on original frame
  const temp2 = document.createElement('canvas'); temp2.width = video.videoWidth; temp2.height = video.videoHeight; const ctx2 = temp2.getContext('2d'); ctx2.drawImage(video,0,0,temp2.width,temp2.height); const imgData2 = ctx2.getImageData(0,0,temp2.width,temp2.height); const gray2 = toGrayscale(imgData2);
  const profile = radialProfile(gray2, cxHigh, cyHigh, rHigh, 360);

  const fftMag = dftReal(profile);

  const mmPerPixel = MIRE_DIAMETER_MM / (2*rHigh);

  return { cx: cxHigh, cy: cyHigh, r: rHigh, score: best.score, votes: best.votes, mmPerPixel, radialProfile: profile, radialFFT: fftMag };
}

// helper to run detection multiple times and pick best
async function detectBestCircle(video, attempts=4, delayMs=120){
  let bestAll = null;
  for(let i=0;i<attempts;i++){
    const res = await detectBestCircleFromVideoFrame(video);
    if(res && (!bestAll || res.score > bestAll.score)) bestAll = res;
    await new Promise(r=>setTimeout(r, delayMs));
  }
  return bestAll;
}

// expose functions globally
window.MireAnalyzer = { detectBestCircle, detectBestCircleFromVideoFrame };

/* Usage:
   await MireAnalyzer.detectBestCircle(videoElement).then(res => { if(res) console.log(res); });
*/
