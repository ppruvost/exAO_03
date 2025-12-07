/* ========================================
   STYLE GLOBAL
   ======================================== */
body {
  margin: 0;
  padding: 20px;
  font-family: Arial, Helvetica, sans-serif;
  background: #f4f4f4;
  color: #333;
  -webkit-tap-highlight-color: transparent;
}

h1, h2, h3 {
  text-align: center;
  margin-bottom: 15px;
}

h2 { font-size: 1.6rem; }
h3 { font-size: 1.25rem; }

/* ========================================
   CONTENEUR VIDEO
   ======================================== */
#videoWrapper {
  position: relative;
  width: 100%;
  max-width: 640px;
  margin: 0 auto 15px auto;
  border-radius: 10px;
  overflow: hidden; /* empêche tout débordement (fix bandeau noir) */
  background: black;
}

/* Vidéo plein cadre */
#preview {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 10px;
  display: block;
  z-index: 1;
}

/* Canvas de détection par-dessus la vidéo */
#previewCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  border-radius: 10px;
  z-index: 2;
}

/* Overlay mire optionnel */
#mireOverlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 3;
}

/* ========================================
   CONTROLES / BOUTONS
   ======================================== */
#controls {
  text-align: center;
  margin-bottom: 15px;
}

button {
  display: inline-block;
  background: #333;
  color: white;
  border: none;
  padding: 12px 20px;
  margin: 8px 4px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.2s, transform 0.15s;
}

button:hover {
  background: #444;
}

button:active {
  transform: scale(0.96);
}

/* ========================================
   INFORMATIONS / LABELS
   ======================================== */
.info {
  max-width: 640px;
  margin: 0 auto 15px auto;
  padding: 12px 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
  font-size: 1rem;
}

.info p {
  margin: 5px 0;
}

#rampAngleDisplay,
#pxToMeterDisplay,
#nSamples,
#aEstimated,
#aTheory {
  font-weight: bold;
  color: #444;
}

/* ========================================
   CANVASES GRAPHIQUES
   ======================================== */
canvas {
  border: 1px solid #444;
  background: #fff;
  display: block;
  margin: 10px auto;
  border-radius: 6px;
}

/* ========================================
   RESPONSIVE MOBILE
   ======================================== */
@media (max-width: 600px) {

  body { padding: 10px; }

  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.2rem; }
  h3 { font-size: 1rem; }

  button {
    width: 100%;
    margin: 6px 0;
    padding: 12px;
  }

  .info {
    padding: 8px;
    font-size: 0.95rem;
  }

  canvas {
    max-width: 100%;
    height: auto;
  }
}
