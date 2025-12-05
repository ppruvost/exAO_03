// --- UTILITAIRES MATH ---
function fitEllipse(points) {
  if (points.length < 20) return null;
  const D = points.map(p => [p.x*p.x, p.x*p.y, p.y*p.y, p.x, p.y, 1]);
  const S = numeric.dot(numeric.transpose(D), D);
  const S1 = [[S[0][0], S[0][1], S[0][2]], [S[1][0], S[1][1], S[1][2]], [S[2][0], S[2][1], S[2][2]]];
  const S2 = [[S[0][3], S[0][4], S[0][5]], [S[1][3], S[1][4], S[1][5]], [S[2][3], S[2][4], S[2][5]]];
  const S3 = [[S[3][3], S[3][4], S[3][5]], [S[4][3], S[4][4], S[4][5]], [S[5][3], S[5][4], S[5][5]]];

  const T = numeric.neg(numeric.dot(numeric.inv(S3), numeric.transpose(S2)));
  const M = numeric.add(S1, numeric.dot(S2, T));
  const C = [[0,0,2],[0,-1,0],[2,0,0]];

  const eig = numeric.eig(numeric.dot(numeric.inv(C), M));
  const eigVecs = eig.E;
  const a = eigVecs.map(col => col[0]);
  const A = [a[0], a[1], a[2]];
  const B = numeric.dot(T, A);

  return { A: a[0], B: a[1], C: a[2], D: B[0], E: B[1], F: B[2] };
}

function ellipseParams(coeffs) {
  const { A, B, C, D, E, F } = coeffs;
  const num = B*B - 4*A*C;
  if (num >= 0) return null;

  const x0 = (2*C*D - B*E)/num;
  const y0 = (2*A*E - B*D)/num;
  const up = 2*(A*E*E + C*D*D + F*B*B - 2*B*D*E - A*C*F);
  const down1 = (B*B - A*C)*((C-A)*Math.sqrt(1+(4*B*B)/((A-C)*(A-C)))-(C+A));
  const down2 = (B*B - A*C)*((A-C)*Math.sqrt(1+(4*B*B)/((A-C)*(A-C)))-(C+A));

  const a = Math.sqrt(Math.abs(up/down1));
  const b = Math.sqrt(Math.abs(up/down2));
  const phi = 0.5*Math.atan2(B, A-C);

  return { cx:x0, cy:y0, a, b, phi };
}

function computeInclinationFromEllipse(a,b){
  return Math.acos(b/a) * 180/Math.PI;
}

function extractEdgePoints(video){
  const w = video.videoWidth, h = video.videoHeight;
  const temp = document.createElement('canvas');
  temp.width = w; temp.height = h;
  const ctx = temp.getContext('2d');
  ctx.drawImage(video,0,0,w,h);
  const img = ctx.getImageData(0,0,w,h);
  const data = img.data;

  const points = [];
  for(let y=1;y<h-1;y+=2){
    for(let x=1;x<w-1;x+=2){
      const i = (y*w + x)*4;
      const gx = (data[i+4]-data[i-4]) + (data[i+4*w]-data[i-4*w]);
      const gy = (data[i+4*w]-data[i-4*w]) + (data[i+4]-data[i-4]);
      const mag = Math.sqrt(gx*gx + gy*gy);
      if(mag>20) points.push({x,y});
    }
  }
  return points;
}

// --- BOUCLE PRINCIPALE ---
async function startWebcamAnalysis(){
  const video = document.getElementById('video');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:true });
    video.srcObject = stream;
    await video.play();

    function loop(){
      const pts = extractEdgePoints(video);
      const el = fitEllipse(pts);
      if(el){
        const params = ellipseParams(el);
        if(params){
          const angle = computeInclinationFromEllipse(params.a, params.b);
          document.getElementById('calibInfo').innerText = `Inclinaison : ${angle.toFixed(2)}°`;
        }
      }
      requestAnimationFrame(loop);
    }
    loop();
  } catch(err){
    console.error("Erreur webcam :", err);
    alert("Impossible d'accéder à la webcam : "+err.message);
  }
}

function detectMireInstantanee(){
  console.log("Détection instantanée !");
  const video = document.getElementById('video');
  const pts = extractEdgePoints(video);
  const el = fitEllipse(pts);
  if(el){
    const params = ellipseParams(el);
    if(params){
      const angle = computeInclinationFromEllipse(params.a, params.b);
      alert(`Angle détecté : ${angle.toFixed(2)}°`);
    }
  } else {
    alert("Pas assez de points pour détecter l'ellipse.");
  }
}

function autoCalibAngle(){
  console.log("Auto‑calibration + Angle !");
  detectMireInstantanee();
}

// --- Expose globalement pour HTML ---
window.startWebcamAnalysis = startWebcamAnalysis;
window.detectMireInstantanee = detectMireInstantanee;
window.autoCalibAngle = autoCalibAngle;
