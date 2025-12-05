/* -------------------------
datasets: [
{ label: 'Vitesse (cm / 0.1s)', data: T.map((t,i)=>({x:t, y: V[i]})), pointRadius:3 },
{ label: 'Régression linéaire', data: T.map(t=>({x:t, y: fitParams.a*t + fitParams.b})), type:'line', fill:false }
]
},
options: {
parsing: false,
scales: {
x: { type:'linear', title:{display:true, text:'t (s)'} },
y: { title:{display:true, text:'v (cm / 0.1s)'} }
}
}
});
}


function buildPositionChart(T, posCm, fitPos, coeffs){
if(posChart) posChart.destroy();
posChart = new Chart(posCanvas, {
type: 'line',
data: {
labels: T,
datasets: [
{ label: 'Position (cm)', data: posCm, fill:false, pointRadius:3 },
{ label: 'Fit quadratique', data: fitPos, type:'line', fill:false, borderDash:[6,4], pointRadius:0 }
]
},
options: {
scales: { x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'position (cm)'} } }
}
});
}


// export CSV (filtered samples): on export, we recompute arrays from samplesFilt
exportCSVBtn && exportCSVBtn.addEventListener('click', ()=>{
if(!samplesFilt.length) { alert('Aucune donnée filtrée à exporter.'); return; }
const header = ['t(s)','x(m)','y(m)','vx(m/s)','vy(m/s)'];
const rows = samplesFilt.map(s => [s.t.toFixed(4), s.x.toFixed(6), s.y.toFixed(6), s.vx.toFixed(6), s.vy.toFixed(6)].join(','));
const csv = [header.join(','), ...rows].join('\n');
const blob = new Blob([csv], {type:'text/csv'});
const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'data_filtered.csv'; document.body.appendChild(a); a.click(); a.remove();
});


// expose small helper (re-uses Kalman matrix helpers defined earlier in the original script)
function createKalman(){
let x = [[0],[0],[0],[0]]; let P = identity(4,1e3);
const qPos=1e-5, qVel=1e-3; let Q = [[qPos,0,0,0],[0,qVel,0,0],[0,0,qPos,0],[0,0,0,qVel]];
const H = [[1,0,0,0],[0,0,1,0]]; let R = [[1e-6,0],[0,1e-6]];
function predict(dt){ const F=[[1,dt,0,0],[0,1,0,0],[0,0,1,dt],[0,0,0,1]]; x=matMul(F,x); P=add(matMul(matMul(F,P),transpose(F)), Q); }
function update(z){ const y_resid = sub(z, matMul(H,x)); const S = add(matMul(matMul(H,P),transpose(H)), R); const K = matMul(matMul(P, transpose(H)), inv2x2(S)); x = add(x, matMul(K, y_resid)); const I=identity(4); const KH = matMul(K,H); P = matMul(sub(I,KH),P); }
function setFromMeasurement(z){ x=[[z[0][0]],[0],[z[1][0]],[0]]; P=identity(4,1e-1); }
function getState(){ return { x:x[0][0], vx:x[1][0], y:x[2][0], vy:x[3][0] }; }
return { predict, update, getState, setFromMeasurement };
}


// matrix helpers (copiés depuis script d'origine)
function identity(n, scale=1){ return Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=> i===j?scale:0)); }
function transpose(A){ return A[0].map((_,c)=>A.map(r=>r[c])); }
function matMul(A,B){ const aR=A.length, aC=A[0].length, bC=B[0].length; const C = Array.from({length:aR}, ()=>Array.from({length:bC}, ()=>0)); for(let i=0;i<aR;i++){ for(let k=0;k<aC;k++){ const aik=A[i][k]; for(let j=0;j<bC;j++){ C[i][j] += aik * B[k][j]; } } } return C; }
function add(A,B){ return A.map((row,i)=>row.map((v,j)=>v + B[i][j])); }
function sub(A,B){ return A.map((row,i)=>row.map((v,j)=>v - B[i][j])); }
function inv2x2(M){ const a=M[0][0], b=M[0][1], c=M[1][0], d=M[1][1]; const det = a*d - b*c; if(Math.abs(det)<1e-12) return [[1e12,0],[0,1e12]]; return [[d/det, -b/det], [-c/det, a/det]]; }


})();
