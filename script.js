/****************************************************
 * script.js — exAO_03 (détection balle + mire)
 * Détection trajectoire + estimation angle plan incliné
 * + graphiques + export CSV
 ****************************************************/

/* -------------------------
   GLOBAL
-------------------------- */
let video = null;
let canvas = null;
let ctx = null;

let recorder = null;
let recordedChunks = [];
let loadedVideo = null;

let samples = [];     // {t, x, y, xm, ym, vx, vy}
let pxToMeter = 0.002; // calibration par défaut
let slowMoFactor = 1;

/* -------------------------
   INIT DOM
-------------------------- */
window.onload = () => {
    video = document.getElementById("preview");
    canvas = document.getElementById("previewCanvas");
    ctx = canvas.getContext("2d");

    document.getElementById("startRecBtn").onclick = startRecording;
    document.getElementById("stopRecBtn").onclick = stopRecording;
    document.getElementById("loadFileBtn").onclick = () => document.getElementById("fileInput").click();
    document.getElementById("fileInput").onchange = loadVideoFile;
    document.getElementById("processBtn").onclick = processVideo;
    document.getElementById("slowMoBtn").onclick = toggleSlowMo;
    document.getElementById("exportCSVBtn").onclick = exportCSV;

    startLiveVideo();
};

/****************************************************
 * 1) VIDEO DIRECTE (WEBCAM)
 ****************************************************/
async function startLiveVideo() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
    } catch (e) {
        alert("Caméra non accessible : " + e);
    }
}

/****************************************************
 * 2) ENREGISTREMENT VIDEO
 ****************************************************/
function startRecording() {
    const stream = video.srcObject;
    recorder = new MediaRecorder(stream);
    recordedChunks = [];

    recorder.ondataavailable = e => recordedChunks.push(e.data);
    recorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "video/webm" });
        loadedVideo = URL.createObjectURL(blob);
        document.getElementById("processBtn").disabled = false;
    };

    recorder.start();
    document.getElementById("recState").textContent = "État : Enregistrement…";
    document.getElementById("startRecBtn").disabled = true;
    document.getElementById("stopRecBtn").disabled = false;
}

function stopRecording() {
    recorder.stop();
    document.getElementById("recState").textContent = "État : Terminé";
    document.getElementById("startRecBtn").disabled = false;
    document.getElementById("stopRecBtn").disabled = true;
}

/****************************************************
 * 3) CHARGEMENT VIDEO FICHIER
 ****************************************************/
function loadVideoFile(evt) {
    const file = evt.target.files[0];
    if (!file) return;

    loadedVideo = URL.createObjectURL(file);
    document.getElementById("processBtn").disabled = false;
}

/****************************************************
 * 4) TRAITEMENT VIDEO
 ****************************************************/
async function processVideo() {
    samples = [];

    const tmpVideo = document.createElement("video");
    tmpVideo.src = loadedVideo;
    tmpVideo.muted = true;
    tmpVideo.playsInline = true;

    await tmpVideo.play();
    await new Promise(res => setTimeout(res, 200));

    const fps = 30;
    const dt = 1 / fps;

    const W = canvas.width;
    const H = canvas.height;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = W;
    tempCanvas.height = H;
    const tCtx = tempCanvas.getContext("2d");

    let t = 0;

    while (!tmpVideo.ended) {
        // Dessine frame
        tCtx.drawImage(tmpVideo, 0, 0, W, H);
        const img = tCtx.getImageData(0, 0, W, H);

        const pt = detectObject(img);  // balle ou mire auto
        if (pt) {
            const xm = pt.x * pxToMeter;
            const ym = pt.y * pxToMeter;

            samples.push({ t, x: pt.x, y: pt.y, xm, ym });

            drawPoint(pt.x, pt.y);
        }
        t += dt;
        await waitFrame(1000 * dt * slowMoFactor);
    }

    computeVelocities();
    computeAcceleration();
    drawCharts();
    computeRampAngle();

    document.getElementById("nSamples").textContent = samples.length;
    document.getElementById("exportCSVBtn").disabled = false;
}

function waitFrame(ms) {
    return new Promise(res => setTimeout(res, ms));
}

/****************************************************
 * 5) DETECTION AUTOMATIQUE (balle OU mire)
 ****************************************************/
function detectObject(img) {
    const ptBall = detectBall(img);
    const ptMire = detectMire(img);

    if (ptBall && ptMire) {
        return (ptBall.count > ptMire.count) ? ptBall : ptMire;
    }
    return ptBall || ptMire;
}

/****************************************************
 * 5A) DETECTION BALLE JAUNE
 ****************************************************/
function detectBall(imgData, stride = 3) {
    const data = imgData.data;
    const W = imgData.width, H = imgData.height;
    let sx = 0, sy = 0, cnt = 0;

    for (let y = 0; y < H; y += stride) {
        for (let x = 0; x < W; x += stride) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];

            const {h,s,v} = rgbToHsv(r,g,b);

            const ok =
                h > 40 && h < 70 &&
                s > 0.3 && s < 0.9 &&
                v > 0.55;

            if (!ok) continue;

            sx += x;
            sy += y;
            cnt++;
        }
    }

    if (cnt < 40) return null;
    return { x: sx / cnt, y: sy / cnt, count: cnt };
}

/****************************************************
 * 5B) DETECTION MIRE DE FOUCAULT (binaire noir/blanc)
 ****************************************************/
function detectMire(imgData, stride = 3) {
    const data = imgData.data;
    const W = imgData.width, H = imgData.height;
    let sx = 0, sy = 0, cnt = 0;

    for (let y=0; y<H; y+=stride) {
        for (let x=0; x<W; x+=stride) {

            const i = (y*W + x)*4;
            const r=data[i], g=data[i+1], b=data[i+2];
            const lum = (r+g+b)/3;

            // Mire : alternance dense noir/blanc → seuil serré
            if (lum < 40 || lum > 215) {
                sx += x;
                sy += y;
                cnt++;
            }
        }
    }

    if (cnt < 150) return null;
    return { x: sx/cnt, y: sy/cnt, count: cnt };
}

/****************************************************
 * HSV
 ****************************************************/
function rgbToHsv(r,g,b) {
    r/=255; g/=255; b/=255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h, s, v=max;
    const d = max-min;
    s = max===0 ? 0 : d/max;

    if (max===min) h=0;
    else{
        switch(max){
            case r: h=(g-b)/d+(g<b?6:0); break;
            case g: h=(b-r)/d+2; break;
            case b: h=(r-g)/d+4; break;
        }
        h /= 6;
    }
    return {h: h*360, s, v};
}

/****************************************************
 * 6) DESSIN DU POINT
 ****************************************************/
function drawPoint(x,y) {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, 2*Math.PI);
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 3;
    ctx.stroke();
}

/****************************************************
 * 7) VITESSES
 ****************************************************/
function computeVelocities() {
    for (let i=1; i<samples.length; i++) {
        const dt = samples[i].t - samples[i-1].t;
        samples[i].vx = (samples[i].xm - samples[i-1].xm)/dt;
        samples[i].vy = (samples[i].ym - samples[i-1].ym)/dt;
    }
}

/****************************************************
 * 8) ACCÉLÉRATION
 ****************************************************/
function computeAcceleration() {
    if (samples.length < 3) return;

    // regression sur x(t)
    const xs = samples.map(s => s.xm);
    const ts = samples.map(s => s.t);

    const {a} = fitParabola(ts, xs);
    document.getElementById("aEstimated").textContent = a.toFixed(3);
}

/****************************************************
 * FIT PARABOLE: x(t) = a/2 t² + v0 t + x0
 ****************************************************/
function fitParabola(t, x) {
    let n = t.length;
    let S0=n, S1=0, S2=0, S3=0, S4=0;
    let T0=0, T1=0, T2=0;

    for (let i=0;i<n;i++) {
        S1 += t[i];
        S2 += t[i]**2;
        S3 += t[i]**3;
        S4 += t[i]**4;

        T0 += x[i];
        T1 += t[i]*x[i];
        T2 += t[i]**2*x[i];
    }

    // Résolution du système (Moore-Penrose simplifié)
    const A = [
        [S4, S3, S2],
        [S3, S2, S1],
        [S2, S1, S0]
    ];
    const B = [T2, T1, T0];

    const X = solve3x3(A, B);

    const a = 2*X[0];  // car x = (a/2)t² + ...
    return {a, v0: X[1], x0: X[2]};
}

/****************************************************
 * Résolution système 3x3
 ****************************************************/
function solve3x3(A, B) {
    const m = JSON.parse(JSON.stringify(A));
    const b = B.slice();

    for (let i=0;i<3;i++){
        let pivot = m[i][i];
        for (let j=i;j<3;j++) m[i][j]/=pivot;
        b[i]/=pivot;

        for (let k=0;k<3;k++){
            if (k===i) continue;
            const f = m[k][i];
            for (let j=i;j<3;j++) m[k][j] -= f*m[i][j];
            b[k] -= f*b[i];
        }
    }
    return b;
}

/****************************************************
 * 9) ESTIMATION ANGLE DU PLAN
 ****************************************************/
function computeRampAngle() {
    if (samples.length < 4) return;

    const xs = samples.map(s=>s.xm);
    const ys = samples.map(s=>s.ym);

    // fit ligne y(x)
    const {m} = linearFit(xs, ys);
    const angle = Math.atan(m) * 180/Math.PI;

    document.getElementById("rampAngleDisplay").textContent =
        angle.toFixed(2) + "°";
}

function linearFit(x,y) {
    let n=x.length, Sx=0,Sy=0,Sxx=0,Sxy=0;
    for (let i=0;i<n;i++){
        Sx+=x[i];
        Sy+=y[i];
        Sxx+=x[i]*x[i];
        Sxy+=x[i]*y[i];
    }
    const m = (n*Sxy - Sx*Sy)/(n*Sxx - Sx*Sx);
    const b = (Sy - m*Sx)/n;
    return {m,b};
}

/****************************************************
 * 10) GRAPHIQUES
 ****************************************************/
let posChart=null, velChart=null;

function drawCharts() {
    const t = samples.map(s=>s.t);
    const x = samples.map(s=>s.xm);
    const v = samples.map(s=>s.vx);

    if (posChart) posChart.destroy();
    if (velChart) velChart.destroy();

    posChart = new Chart(document.getElementById("posChart"), {
        type:'line',
        data:{
            labels:t,
            datasets:[{
                label:'Position (m)',
                data:x,
                borderColor:'blue'
            }]
        },
        options:{ responsive:true }
    });

    velChart = new Chart(document.getElementById("velChart"), {
        type:'line',
        data:{
            labels:t,
            datasets:[{
                label:'Vitesse (m/s)',
                data:v,
                borderColor:'red'
            }]
        },
        options:{ responsive:true }
    });
}

/****************************************************
 * 11) RALENTI
 ****************************************************/
function toggleSlowMo() {
    slowMoFactor = slowMoFactor===1 ? 0.4 : 1;
    document.getElementById("slowMoBtn").textContent =
        slowMoFactor===1 ? "Ralenti ×1" : "Ralenti ×0.4";
}

/****************************************************
 * 12) EXPORT CSV
 ****************************************************/
function exportCSV() {
    let csv = "t,x(m),y(m),vx,vy\n";
    for (const s of samples) {
        csv += `${s.t},${s.xm},${s.ym},${s.vx||""},${s.vy||""}\n`;
    }
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "exAO_mouvement.csv";
    a.click();
}
