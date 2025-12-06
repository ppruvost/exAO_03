/* EXTRACT EDGE POINTS */
function extractEdgePoints(video){
  const w=video.videoWidth,h=video.videoHeight;
  const temp=document.createElement('canvas');
  temp.width=w; temp.height=h;
  const ctx=temp.getContext('2d');
  ctx.drawImage(video,0,0,w,h);
  const img=ctx.getImageData(0,0,w,h).data;

  const pts=[];
  for(let y=1;y<h-1;y+=2){
    for(let x=1;x<w-1;x+=2){
      const i=(y*w+x)*4;
      const gx=(img[i+4]-img[i-4]) + (img[i+4*w]-img[i-4*w]);
      const gy=(img[i+4*w]-img[i-4*w]) + (img[i+4]-img[i-4]);
      if(Math.hypot(gx,gy)>20) pts.push({x,y});
    }
  }
  return pts;
}

/* FIT ELLIPSE */
function fitEllipse(points){
  if(points.length<20) return null;
  const D = points.map(p => [p.x*p.x, p.x*p.y, p.y*p.y, p.x, p.y, 1]);
  const S = numeric.dot(numeric.transpose(D), D);

  const S1=[[S[0][0],S[0][1],S[0][2]],[S[1][0],S[1][1],S[1][2]],[S[2][0],S[2][1],S[2][2]]];
  const S2=[[S[0][3],S[0][4],S[0][5]],[S[1][3],S[1][4],S[1][5]],[S[2][3],S[2][4],S[2][5]]];
  const S3=[[S[3][3],S[3][4],S[3][5]],[S[4][3],S[4][4],S[4][5]],[S[5][3],S[5][4],S[5][5]]];

  const T=numeric.neg(numeric.dot(numeric.inv(S3),numeric.transpose(S2)));
  const M=numeric.add(S1,numeric.dot(S2,T));
  const C=[[0,0,2],[0,-1,0],[2,0,0]];

  const eig=numeric.eig(numeric.dot(numeric.inv(C),M));
  const eigVecs=eig.E;
  const a=[eigVecs[0][0],eigVecs[1][0],eigVecs[2][0]];
  const B=numeric.dot(T,a);

  return {A:a[0],B:a[1],C:a[2],D:B[0],E:B[1],F:B[2]};
}

function ellipseParams(c){
  const {A,B,C,D,E,F}=c;
  const num=B*B-4*A*C;
  if(num>=0) return null;

  const x0=(2*C*D-B*E)/num;
  const y0=(2*A*E-B*D)/num;

  const up=2*(A*E*E+C*D*D+F*B*B-2*B*D*E-A*C*F);
  const down1=(B*B-A*C)*((C-A)*Math.sqrt(1+(4*B*B)/((A-C)*(A-C)))-(C+A));
  const down2=(B*B-A*C)*((A-C)*Math.sqrt(1+(4*B*B)/((A-C)*(A-C)))-(C+A));

  return {
    cx:x0, cy:y0,
    a:Math.sqrt(Math.abs(up/down1)),
    b:Math.sqrt(Math.abs(up/down2))
  };
}

/* ANGLE = arccos(b/a), 1 décimale */
function computeInclination(a,b){
  const ang = Math.acos(b/a) * 180/Math.PI;
  return ang.toFixed(1);
}

/* ----- BOUTONS ----- */
async function detectMireInstantanee(){
  const video=document.getElementById('video');

  // 1) Détection du cercle
  const circle=await MireAnalyzer.detectBestCircle(video);
  if(!circle){ alert("Mire non détectée"); return; }

  // 2) extraction contours ellipse
  const pts=extractEdgePoints(video);
  const el=fitEllipse(pts);
  if(!el){ alert("Ellipse non détectée"); return; }

  const p=ellipseParams(el);
  if(!p){ alert("Paramètres ellipse invalides"); return; }

  const ang=computeInclination(p.a,p.b);
  alert("Angle détecté : " + ang + "°");
}

async function autoCalibAngle(){
  const video=document.getElementById('video');

  const circle=await MireAnalyzer.detectBestCircle(video);
  if(!circle){ return; }

  const pts=extractEdgePoints(video);
  const el=fitEllipse(pts);
  if(!el) return;

  const p=ellipseParams(el);
  if(!p) return;

  const ang=computeInclination(p.a,p.b);

  document.getElementById("calibInfo").innerText = "Angle : " + ang + "°";
}

async function startWebcamAnalysis(){
  const video=document.getElementById('video');
  const stream=await navigator.mediaDevices.getUserMedia({video:true});
  video.srcObject=stream;
  await video.play();

  async function loop(){
    await autoCalibAngle();
    requestAnimationFrame(loop);
  }
  loop();
}

window.startWebcamAnalysis=startWebcamAnalysis;
window.detectMireInstantanee=detectMireInstantanee;
window.autoCalibAngle=autoCalibAngle;
