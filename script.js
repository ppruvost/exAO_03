/* Détection principale de la mire : Hough + FFT.
   Retourne { cx, cy, r, score, mmPerPixel } */

const MIRE_DIAMETER_MM = 85;
const MAX_PROC_WIDTH = 480;

// Convertit image en niveaux de gris
function toGrayscale(imgData){
  const w=imgData.width,h=imgData.height,data=imgData.data;
  const out=new Uint8ClampedArray(w*h);
  for(let i=0,j=0;i<data.length;i+=4,j++)
    out[j]=(0.299*data[i]+0.587*data[i+1]+0.114*data[i+2])|0;
  return {data:out,width:w,height:h};
}

function boxBlur(gray,radius=1){
  const w=gray.width,h=gray.height,src=gray.data;
  const out=new Uint8ClampedArray(w*h);
  const k=2*radius+1, area=k*k;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let sum=0;
      for(let dy=-radius;dy<=radius;dy++){
        const yy=Math.min(h-1,Math.max(0,y+dy));
        for(let dx=-radius;dx<=radius;dx++){
          const xx=Math.min(w-1,Math.max(0,x+dx));
          sum+=src[yy*w+xx];
        }
      }
      out[y*w+x]=(sum/area)|0;
    }
  }
  return {data:out,width:w,height:h};
}

function sobelMagnitude(gray){
  const w=gray.width,h=gray.height,src=gray.data;
  const out=new Float32Array(w*h);
  const gx=[-1,0,1,-2,0,2,-1,0,1];
  const gy=[-1,-2,-1,0,0,0,1,2,1];
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let sx=0,sy=0,k=0;
      for(let j=-1;j<=1;j++){
        for(let i=-1;i<=1;i++){
          const v=src[(y+j)*w+(x+i)];
          sx+=v*gx[k]; sy+=v*gy[k]; k++;
        }
      }
      out[y*w+x]=Math.hypot(sx,sy);
    }
  }
  return {data:out,width:w,height:h};
}

function edgeBinary(sobel,thresh){
  const w=sobel.width,h=sobel.height,src=sobel.data;
  const out=new Uint8ClampedArray(w*h);
  for(let i=0;i<w*h;i++) out[i]=(src[i]>=thresh)?1:0;
  return {data:out,width:w,height:h};
}

// Hough circle simplifié (centre + rayon)
function houghCircle(edges,rMin,rMax,stepR=2){
  const w=edges.width,h=edges.height,data=edges.data;
  const acc=new Int32Array(w*h);
  let best=null;

  const edgePoints=[];
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++) if(data[y*w+x]) edgePoints.push({x,y});
  }
  if(edgePoints.length===0) return null;

  for(let r=rMin;r<=rMax;r+=stepR){
    acc.fill(0);
    for(const p of edgePoints){
      const x0=p.x,y0=p.y;
      for(let t=0;t<360;t+=6){
        const rad=t*Math.PI/180;
        const a=Math.round(x0-r*Math.cos(rad));
        const b=Math.round(y0-r*Math.sin(rad));
        if(a>=0&&a<w&&b>=0&&b<h) acc[b*w+a]++;
      }
    }
    let max=0,idx=-1;
    for(let i=0;i<w*h;i++) if(acc[i]>max){max=acc[i];idx=i;}
    if(max>10){
      const cy=Math.floor(idx/w),cx=idx%w;
      const score=max/60;
      if(!best||score>best.score) best={cx,cy,r,score};
    }
  }
  return best;
}

async function detectBestCircleFromVideoFrame(video){
  const temp=document.createElement('canvas');
  const scale=Math.min(1,MAX_PROC_WIDTH/video.videoWidth);
  temp.width=Math.floor(video.videoWidth*scale);
  temp.height=Math.floor(video.videoHeight*scale);

  const ctx=temp.getContext('2d');
  ctx.drawImage(video,0,0,temp.width,temp.height);

  const img=ctx.getImageData(0,0,temp.width,temp.height);
  const gray=toGrayscale(img);
  const blur=boxBlur(gray,1);
  const sob=sobelMagnitude(blur);

  let maxG=0;
  sob.data.forEach(v=>{if(v>maxG)maxG=v;});
  const edge=edgeBinary(sob,maxG*0.25);

  const diag=Math.hypot(temp.width,temp.height);
  const guessDiam=Math.min(temp.width*0.6,Math.max(20,diag*0.35));
  const rMin=Math.floor(guessDiam*0.6/2);
  const rMax=Math.floor(guessDiam*1.4/2);

  const best=houghCircle(edge,rMin,rMax,2);
  if(!best) return null;

  const scaleX=video.videoWidth/temp.width;
  const scaleY=video.videoHeight/temp.height;

  return {
    cx:Math.round(best.cx*scaleX),
    cy:Math.round(best.cy*scaleY),
    r:Math.round(best.r*(scaleX+scaleY)/2),
    score:best.score,
    mmPerPixel:MIRE_DIAMETER_MM/(2*Math.round(best.r*(scaleX+scaleY)/2))
  };
}

async function detectBestCircle(video){
  let best=null;
  for(let i=0;i<4;i++){
    const r=await detectBestCircleFromVideoFrame(video);
    if(r&&(!best||r.score>best.score)) best=r;
    await new Promise(res=>setTimeout(res,120));
  }
  return best;
}

window.MireAnalyzer={detectBestCircle};
