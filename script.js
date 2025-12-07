/************************************************************
 *  script.js — Détection d’objet mobile + graphiques temps réel
 ************************************************************/

// ========================
// CONFIG
// ========================
const STRIDE = 2;                // échantillonnage pour accélérer
const MIN_PIXELS = 30;           // min pixels pour reconnaître un objet
const BG_CAPTURE_FRAMES = 20;    // nombre d’images pour moyenne du fond
const BALL_H_MIN = 35, BALL_H_MAX = 75; // jaune balle de tennis

// ========================
// GLOBALS
// ========================
let video, canvas, ctx;
let bgData = null;           // background moyen
let frameCount = 0;
let tracking = [];
let lastTime = null;

// graphiques
let chartX, chartY, chartV, chartA;

// =====================================================
// INITIALISATION
// =====================================================
window.onload = async () => {
    video = document.getElementById("video");
    canvas = document.getElementById("canvas");
    ctx = canvas.getContext("2d");

    await initCamera();
    initCharts();
    requestAnimationFrame(loop);
};

async function initCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 }
    });
    video.srcObject = stream;
    await video.play();
}

// =====================================================
// FONCTIONS UTILITAIRES
// =====================================================
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h, s, v = max;
    let d = max - min;
    s = max === 0 ? 0 : d / max;

    if (max === min) h = 0;
    else {
        switch (max) {
            case r: h = (g-b)/d + (g < b ? 6 : 0); break;
            case g: h = (b-r)/d + 2; break;
            case b: h = (r-g)/d + 4; break;
        }
        h /= 6;
    }
    return { h: h*360, s, v };
}

// moyenne de plusieurs frames pour fond
function accumulateBackground(frame) {
    const data = frame.data;
    if (!bgData) {
        bgData = new Float32Array(data.length);
    }
    for (let i = 0; i < data.length; i++) {
        bgData[i] += data[i];
    }
    if (frameCount === BG_CAPTURE_FRAMES) {
        for (let i = 0; i < bgData.length; i++)
            bgData[i] /= BG_CAPTURE_FRAMES;
    }
}

// =====================================================
// DÉTECTION OBJET (balle OU mire)
// =====================================================
function detectObject(frame) {
    const data = frame.data;
    const W = frame.width, H = frame.height;

    let sumX = 0, sumY = 0, count = 0;

    const isBgReady = (frameCount > BG_CAPTURE_FRAMES);

    for (let y = 0; y < H; y += STRIDE) {
        for (let x = 0; x < W; x += STRIDE) {

            const i = (y * W + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];

            const hsv = rgbToHsv(r,g,b);

            // ========= IDENTIFICATION BALLE =========
            let isBall =
                hsv.h >= BALL_H_MIN && hsv.h <= BALL_H_MAX &&
                hsv.s > 0.25 && hsv.v > 0.55;  // tolérance luminosité variable

            // ========= MIRE / PENDULE =========
            // objet sombre ou clair mobile par rapport au fond
            let isPendulum = false;
            if (isBgReady) {
                const dr = Math.abs(r - bgData[i]);
                const dg = Math.abs(g - bgData[i+1]);
                const db = Math.abs(b - bgData[i+2]);
                const diff = dr + dg + db;
                isPendulum = diff > 60;  // différence suffisante
            }

            if (!(isBall || isPendulum)) continue;

            sumX += x;
            sumY += y;
            count++;
        }
    }

    if (count < MIN_PIXELS) return null;
    return { x: sumX / count, y: sumY / count, count };
}

// =====================================================
// TRACKING — ANGLE, VITESSE
// =====================================================
function computeMetrics(pt, dt) {
    let v = 0, angle = 0;

    if (tracking.length > 1) {
        const p0 = tracking[tracking.length - 1];
        const dx = pt.x - p0.x;
        const dy = pt.y - p0.y;
        v = Math.sqrt(dx*dx + dy*dy) / dt;
        angle = Math.atan2(dy, dx) * 180 / Math.PI;
    }
    return { v, angle };
}

// =====================================================
// GRAPHIQUES temps réel
// =====================================================
function initCharts() {
    chartX = new Chart(document.getElementById("chartX"), {
        type: "line",
        data: { labels: [], datasets: [{ label:"X", data:[] }] },
        options: { animation:false, responsive:true }
    });
    chartY = new Chart(document.getElementById("chartY"), {
        type: "line",
        data: { labels: [], datasets: [{ label:"Y", data:[] }] },
        options: { animation:false, responsive:true }
    });
    chartV = new Chart(document.getElementById("chartV"), {
        type: "line",
        data: { labels: [], datasets: [{ label:"Vitesse", data:[] }] },
        options: { animation:false, responsive:true }
    });
    chartA = new Chart(document.getElementById("chartA"), {
        type: "line",
        data: { labels: [], datasets: [{ label:"Angle", data:[] }] },
        options: { animation:false, responsive:true }
    });
}

function updateCharts(t, pt, metrics) {
    chartX.data.labels.push(t);
    chartX.data.datasets[0].data.push(pt.x);
    chartX.update();

    chartY.data.labels.push(t);
    chartY.data.datasets[0].data.push(pt.y);
    chartY.update();

    chartV.data.labels.push(t);
    chartV.data.datasets[0].data.push(metrics.v);
    chartV.update();

    chartA.data.labels.push(t);
    chartA.data.datasets[0].data.push(metrics.angle);
    chartA.update();
}

// =====================================================
// BOUCLE PRINCIPALE
// =====================================================
function loop(t) {
    requestAnimationFrame(loop);

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);

    frameCount++;
    if (frameCount <= BG_CAPTURE_FRAMES) {
        accumulateBackground(frame);
        return;
    }

    const pt = detectObject(frame);
    const dt = lastTime ? (t - lastTime)/1000 : 0.016;
    lastTime = t;

    if (pt) {
        tracking.push(pt);
        const metrics = computeMetrics(pt, dt);

        // dessin overlay
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 10, 0, 2*Math.PI);
        ctx.strokeStyle = "red";
        ctx.lineWidth = 3;
        ctx.stroke();

        updateCharts((t/1000).toFixed(2), pt, metrics);
    }
}
