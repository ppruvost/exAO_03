/* webcam.js — Version complète avec détection ellipse (mire de Foucault)
   Objectif : mesurer l'inclinaison du plan incliné via ellipse fitting
   Compatible webcam USB / PC
*/

import { startLiveAnalysis, mmPerPixel } from './script_analyse_mire.js';

// --- UTILITAIRES MATH --------------------------------------------------
function fitEllipse(points) {
  /* Ajustement d'ellipse méthode Direct Least Squares (Fitzgibbon 1999) */
  const len = points.length;
  if (len < 20) return null;

  let D = [];
  for (let i = 0; i < len; i++) {
    const { x, y } = points[i];
    D.push([ x * x, x * y, y * y, x, y, 1 ]);
  }

  // Construction matrices
  let S = numeric.dot(numeric.transpose(D), D);

  // Partition
  let S1 = [[S[0][0], S[0][1], S[0][2]], [S[1][0], S[1][1], S[1][2]], [S[2][0], S[2][1], S[2][2]]];
  let S2 = [[S[0][3], S[0][4], S[0][5]], [S[1][3], S[1][4], S[1][5]], [S[2][3], S[2][4], S[2][5]]];
  let S3 = [[S[3][3], S[3][4], S[3][5]], [S[4][3], S[4][4], S[4][5]], [S[5][3], S[5][4], S[5][5]]];

  let T = numeric.neg(numeric.dot(numeric.inv(S3), numeric.transpose(S2)));
  let M = numeric.add(S1, numeric.dot(S2, T));

  // Contraints matrice C
  let C = [[0, 0, 2], [0, -1, 0], [2, 0, 0]];

  // Solve eigenvalues M a = λ C a
  let eig = numeric.eig(numeric.dot(numeric.inv(C), M));
  let eigVecs = eig.E;

  // Choisir la solution elliptique
  let a = eigVecs.map(col => col[0]);
  const A = [a[0], a[1], a[2]];
  const B = numeric.dot(T, A);

  return {
    A: a[0], B: a[1], C: a[2], D: B[0], E: B[1], F: B[2]
  };
}

function ellipseParams(coeffs) {
  /* Retourne axes a,b et angle φ à partir coefficients ellipse */
  const { A, B, C, D, E, F } = coeffs;

  const num = B * B - 4 * A * C;
  if (num >= 0) return null; // pas ellipse

  let x0 = (2 * C * D - B * E) / num;
  let y0 = (2 * A * E - B * D) / num;

  let up = 2 * (A * E * E + C * D * D + F * B * B - 2 * B * D * E - A * C * F);
  let down1 = (B * B - A * C) * ((C - A) * Math.sqrt(1 + (4 * B * B) / ((A - C) * (A - C))) - (C + A));
  let down2 = (B * B - A * C) * ((A - C) * Math.sqrt(1 + (4 * B * B) / ((A - C) * (A - C))) - (C + A));

  let a = Math.sqrt(Math.abs(up / down1));
  let b = Math.sqrt(Math.abs(up / down2));

  let phi = 0.5 * Math.atan2(B, A - C);

  return { cx: x0, cy: y0, a, b, phi };
}

// --- EXTRACTION DU CONTOUR ---------------------------------------------
function extractEdgePoints(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const temp = document.createElement('canvas');
  temp.width = w;
  temp.height = h;
  const ctx = temp.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const points = [];
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * 4;
      const gx = (data[i+4] - data[i-4]) + (data[i+4*w] - data[i-4*w]);
      const gy = (data[i+4*w] - data[i-4*w]) + (data[i+4] - data[i-4]);
      const mag = Math.sqrt(gx * gx + gy * gy);

      if (mag > 40) points.push({ x, y });
    }
  }
  return points;
}

// --- CALCUL ANGLE INCLINAISON ------------------------------------------
function computeInclinationFromEllipse(a, b) {
  return Math.acos(b / a) * 180 / Math.PI;
}

// --- BOUCLE PRINCIPALE --------------------------------------------------
async function startWebcamAnalysis() {
  const video = document.getElementById('video');

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await video.play();

  function loop() {
    const pts = extractEdgePoints(video);
    const el = fitEllipse(pts);
    if (el) {
      const params = ellipseParams(el);
      if (params) {
        const angle = computeInclinationFromEllipse(params.a, params.b);
        const out = document.getElementById('angle');
        out.innerText = `Inclinaison : ${angle.toFixed(2)}°`;
      }
    }
    requestAnimationFrame(loop);
  }

  loop();
}

window.startWebcamAnalysis = startWebcamAnalysis;
