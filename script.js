/* ========================================
   STYLE GLOBAL
   ======================================== */
body {
  margin: 0;
  padding: 20px;
  font-family: Arial, Helvetica, sans-serif;
  background: #f4f4f4;
  color: #333;
}

/* ========================================
   CONTENEUR VIDEO
   ======================================== */
#videoWrapper {
  position: relative;
  width: 100%;
  max-width: 640px;
  margin: 0 auto 20px auto;

  /* IMPORTANT : ratio vidéo 4:3 (480/640) = 0.75  
     → empêche l'apparition du bord noir */
  aspect-ratio: 640 / 480;

  border-radius: 12px;
  overflow: hidden;
  background: #000;
}

/* Vidéo */
#preview {
  width: 100%;
  height: 100%;
  position: absolute;

  /* Le vrai fix ici */
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  object-fit: cover;

  border-radius: 12px;
}

/* Canvas par-dessus */
#previewCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  border-radius: 12px;
}
