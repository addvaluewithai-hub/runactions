const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const slug = params.get('project') || 'rooftop-7000';
const localKey = `qserve-editor:${slug}`;

let project;
let originalProject;
let selectedId = null;
let playing = false;
let pxPerSecond = 18;
let undoStack = [];
let raf = null;
let editorKey = sessionStorage.getItem('qserve-editor-key') || '';

const presenter = $('presenterVideo');
const product = $('productVideo');
const still = $('stillImage');
const missing = $('missingMedia');

function clone(value){ return JSON.parse(JSON.stringify(value)); }
function visualTrack(){ return project.tracks.find(t => t.id === 'visual') || project.tracks[0]; }
function clipById(id){ return visualTrack().clips.find(c => c.id === id); }
function assetFor(clip){ return project.media[clip.asset]; }
function fmt(sec){ sec=Math.max(0,sec||0); const m=Math.floor(sec/60); const s=(sec%60).toFixed(1).padStart(4,'0'); return `${String(m).padStart(2,'0')}:${s}`; }
function snap(v){ const step=project.editor?.snap || .1; return Math.round(v/step)*step; }
function duration(clip){ return Math.max(.1,clip.end-clip.start); }
function pushUndo(){ undoStack.push(clone(project)); if(undoStack.length>40) undoStack.shift(); $('undoBtn').disabled=!undoStack.length; }
function markDraft(text='Unsaved draft'){ $('projectStatus').textContent=text; $('projectStatus').style.color='#f6c85f'; localStorage.setItem(localKey,JSON.stringify(project)); }

async function loadProject(){
  let data;
  try{
    const r=await fetch(`/api/projects/${encodeURIComponent(slug)}`,{cache:'no-store'});
    if(r.ok) data=await r.json();
  }catch{}
  if(!data){
    const r=await fetch(`/projects/${encodeURIComponent(slug)}.json`,{cache:'no-store'});
    if(!r.ok) throw new Error(`Project ${slug} not found`);
    data=await r.json();
  }
  originalProject=clone(data);
  const local=localStorage.getItem(localKey);
  project=local ? JSON.parse(local) : clone(data);
  pxPerSecond=project.editor?.pxPerSecond || 18;
  $('zoomRange').value=pxPerSecond;
  $('pipWidth').value=project.pip?.width || .25;
  $('pipBottom').value=project.pip?.bottom || 132;
  $('pipMargin').value=project.pip?.margin || 36;
  $('projectTitle').textContent=project.title;
  $('scrubber').max=project.duration;
  $('timeLabel').textContent=`00:00.0 / ${fmt(project.duration)}`;
  setupMedia();
  renderAll();
}

function setupMedia(){
  presenter.src=project.media.presenter?.src || '';
  product.src=project.media.product?.src || '';
  presenter.muted=false; product.muted=true;
  [presenter,product].forEach(v=>v.addEventListener('error',()=>{ missing.style.display='grid'; }));
  presenter.addEventListener('loadedmetadata',()=>{ missing.style.display='none'; syncPreview(Number($('scrubber').value)||0,true); });
}

function activeClipAt(t){ return visualTrack().clips.find(c => t>=c.start && t<c.end) || visualTrack().clips.at(-1); }

function showMain(el){
  [presenter,product,still].forEach(x=>x.classList.remove('is-main','is-pip'));
  if(el) el.classList.add('is-main');
}

function setPip(on){
  presenter.classList.toggle('is-pip',!!on);
  if(on){
    const p=project.pip || {};
    presenter.style.width=`${(p.width||.25)*100}%`;
    presenter.style.right=`${(p.margin||36)/10.8}%`;
    presenter.style.bottom=`${(p.bottom||132)/19.2}%`;
    presenter.style.borderRadius=`${p.radius||30}px`;
    presenter.style.borderWidth=`${p.border||4}px`;
  }else{
    presenter.style.width='100%'; presenter.style.right='auto'; presenter.style.bottom='auto'; presenter.style.borderRadius='0'; presenter.style.borderWidth='0';
  }
}

function applyStillMotion(clip,t){
  const progress=Math.min(1,Math.max(0,(t-clip.start)/duration(clip)));
  let scale=1, x=0, y=0;
  if(clip.motion==='slowZoom') scale=1+progress*.07;
  if(clip.motion==='focusRight'){ scale=1.28; x=-9; }
  if(clip.motion==='focusCenter'){ scale=1.22; }
  if(clip.motion==='focusTop'){ scale=1.22; y=8; }
  still.style.transform=`translate(${x}%,${y}%) scale(${scale})`;
}

function syncPreview(t,force=false){
  t=Math.max(0,Math.min(project.duration,t));
  const clip=activeClipAt(t);
  if(!clip) return;
  const asset=assetFor(clip);
  const pTime=Math.min(t,presenter.duration||project.duration);
  if(force || Math.abs((presenter.currentTime||0)-pTime)>.12) presenter.currentTime=pTime;

  if(asset?.type==='video' && clip.asset==='presenter'){
    showMain(presenter); setPip(false); still.removeAttribute('src');
  }else if(asset?.type==='video'){
    showMain(product); setPip(clip.pip!==false);
    const src=(clip.sourceIn||0)+(t-clip.start);
    if(force || Math.abs((product.currentTime||0)-src)>.18) product.currentTime=Math.max(0,src);
    product.style.objectFit=clip.fit||'contain';
  }else if(asset?.type==='image'){
    showMain(still); setPip(clip.pip===true);
    if(still.dataset.asset!==clip.asset){ still.src=asset.src; still.dataset.asset=clip.asset; }
    still.style.objectFit=clip.fit||'cover';
    applyStillMotion(clip,t);
  }
  $('scrubber').value=t;
  $('timeLabel').textContent=`${fmt(t)} / ${fmt(project.duration)}`;
  $('playhead').style.left=`${t*pxPerSecond}px`;
}

function tick(){
  if(!playing) return;
  const t=presenter.currentTime;
  syncPreview(t,false);
  const clip=activeClipAt(t);
  if(clip?.asset==='product' && product.paused) product.play().catch(()=>{});
  if(t>=project.duration-.03){ pause(); seek(0); return; }
  raf=requestAnimationFrame(tick);
}
function play(){ playing=true; $('playBtn').textContent='❚❚'; presenter.play().catch(()=>{}); const c=activeClipAt(presenter.currentTime); if(c?.asset==='product') product.play().catch(()=>{}); raf=requestAnimationFrame(tick); }
function pause(){ playing=false; $('playBtn').textContent='▶'; presenter.pause(); product.pause(); if(raf) cancelAnimationFrame(raf); }
function seek(t){ pause(); syncPreview(Number(t),true); }

function renderRuler(){
  const ruler=$('ruler'); ruler.innerHTML='';
  ruler.style.width=`${project.duration*pxPerSecond}px`;
  for(let s=0;s<=project.duration;s+=5){ const d=document.createElement('div'); d.className='ruler-tick'; d.style.left=`${s*pxPerSecond}px`; d.textContent=`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; ruler.appendChild(d); }
}

function renderTimeline(){
  const canvas=$('timelineCanvas'); const lane=$('visualTrack'); lane.innerHTML='';
  const width=project.duration*pxPerSecond;
  canvas.style.width=`${112+width}px`; lane.style.width=`${width}px`;
  visualTrack().clips.sort((a,b)=>a.start-b.start).forEach(clip=>{
    const el=document.createElement('div');
    const asset=assetFor(clip);
    el.className=`clip ${clip.id===selectedId?'selected':''}`;
    el.dataset.id=clip.id; el.dataset.asset=clip.asset; el.dataset.type=asset?.type||'';
    el.style.left=`${clip.start*pxPerSecond}px`; el.style.width=`${Math.max(22,duration(clip)*pxPerSecond)}px`;
    el.innerHTML=`<div class="resize-handle left" data-resize="left"></div><strong>${clip.label||clip.id}</strong><small>${fmt(clip.start)} → ${fmt(clip.end)}</small><div class="resize-handle right" data-resize="right"></div>`;
    el.addEventListener('pointerdown',startClipPointer);
    lane.appendChild(el);
  });
  renderRuler(); $('playhead').style.left=`${Number($('scrubber').value)*pxPerSecond}px`;
}

function startClipPointer(e){
  const el=e.currentTarget; const id=el.dataset.id; selectClip(id);
  const clip=clipById(id); if(!clip) return;
  e.preventDefault(); el.setPointerCapture(e.pointerId);
  const mode=e.target.dataset.resize || 'move';
  const x0=e.clientX; const before=clone(project); const c0=clone(clip); const d0=duration(c0);
  const move=ev=>{
    const ds=(ev.clientX-x0)/pxPerSecond;
    if(mode==='move'){
      const ns=snap(Math.max(0,Math.min(project.duration-d0,c0.start+ds)));
      clip.start=ns; clip.end=snap(ns+d0);
    }else if(mode==='left'){
      const ns=snap(Math.max(0,Math.min(c0.end-.2,c0.start+ds))); const delta=ns-c0.start; clip.start=ns; if(Number.isFinite(c0.sourceIn)) clip.sourceIn=snap(c0.sourceIn+delta);
    }else{
      const ne=snap(Math.max(c0.start+.2,Math.min(project.duration,c0.end+ds))); const delta=ne-c0.end; clip.end=ne; if(Number.isFinite(c0.sourceOut)) clip.sourceOut=snap(c0.sourceOut+delta);
    }
    renderTimeline(); fillInspector(); markDraft();
  };
  const up=()=>{ el.removeEventListener('pointermove',move); el.removeEventListener('pointerup',up); undoStack.push(before); if(undoStack.length>40)undoStack.shift(); $('undoBtn').disabled=false; };
  el.addEventListener('pointermove',move); el.addEventListener('pointerup',up);
}

function selectClip(id){ selectedId=id; renderTimeline(); fillInspector(); }
function fillInspector(){
  const clip=clipById(selectedId); const form=$('clipForm');
  $('emptyInspector').classList.toggle('hidden',!!clip); form.classList.toggle('hidden',!clip); if(!clip)return;
  $('clipLabel').value=clip.label||''; $('clipStart').value=clip.start; $('clipEnd').value=clip.end; $('sourceIn').value=clip.sourceIn??''; $('sourceOut').value=clip.sourceOut??''; $('clipFit').value=clip.fit||'cover'; $('clipMotion').value=clip.motion||''; $('clipPip').checked=clip.pip===true;
  $('clipAsset').innerHTML=Object.entries(project.media).map(([id,a])=>`<option value="${id}" ${id===clip.asset?'selected':''}>${id} · ${a.type}</option>`).join('');
  const isVideo=assetFor(clip)?.type==='video'; document.querySelector('.source-fields').classList.toggle('hidden',!isVideo);
}

function bindInspector(){
  const mutate=(fn)=>{ const c=clipById(selectedId); if(!c)return; pushUndo(); fn(c); renderTimeline(); fillInspector(); markDraft(); syncPreview(Number($('scrubber').value),true); };
  $('clipLabel').onchange=e=>mutate(c=>c.label=e.target.value);
  $('clipStart').onchange=e=>mutate(c=>{const d=duration(c);c.start=snap(+e.target.value);c.end=snap(c.start+d)});
  $('clipEnd').onchange=e=>mutate(c=>c.end=snap(+e.target.value));
  $('sourceIn').onchange=e=>mutate(c=>c.sourceIn=snap(+e.target.value));
  $('sourceOut').onchange=e=>mutate(c=>c.sourceOut=snap(+e.target.value));
  $('clipAsset').onchange=e=>mutate(c=>c.asset=e.target.value);
  $('clipFit').onchange=e=>mutate(c=>c.fit=e.target.value);
  $('clipMotion').onchange=e=>mutate(c=>c.motion=e.target.value);
  $('clipPip').onchange=e=>mutate(c=>c.pip=e.target.checked);
  $('deleteBtn').onclick=()=>{ if(!selectedId)return; pushUndo(); visualTrack().clips=visualTrack().clips.filter(c=>c.id!==selectedId); selectedId=null; renderAll(); markDraft(); };
  $('duplicateBtn').onclick=()=>{ const c=clipById(selectedId); if(!c)return; pushUndo(); const copy=clone(c); copy.id=`${c.id}-copy-${Date.now().toString(36)}`; copy.label=`${c.label} copy`; const d=duration(copy); copy.start=Math.min(project.duration-d,c.end+.2); copy.end=copy.start+d; visualTrack().clips.push(copy); selectedId=copy.id; renderAll(); markDraft(); };
}

function renderAll(){ renderTimeline(); fillInspector(); syncPreview(Number($('scrubber').value)||0,true); }

async function saveProject(){
  localStorage.setItem(localKey,JSON.stringify(project));
  if(!editorKey) editorKey=prompt('Editor key for publishing this project to GitHub:')||'';
  if(!editorKey){ $('projectStatus').textContent='Saved locally'; return; }
  sessionStorage.setItem('qserve-editor-key',editorKey);
  try{
    const r=await fetch(`/api/projects/${encodeURIComponent(slug)}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Editor-Key':editorKey},body:JSON.stringify(project)});
    if(r.status===401){ editorKey=''; sessionStorage.removeItem('qserve-editor-key'); throw new Error('Wrong editor key'); }
    if(!r.ok) throw new Error(await r.text());
    localStorage.removeItem(localKey); originalProject=clone(project); $('projectStatus').textContent='Saved to GitHub'; $('projectStatus').style.color='#6de876';
  }catch(err){ $('projectStatus').textContent='Local only'; alert(`Saved locally, but GitHub save failed: ${err.message}`); }
}

async function requestRender(){
  if(!editorKey) editorKey=prompt('Editor key to start a render:')||'';
  if(!editorKey)return;
  sessionStorage.setItem('qserve-editor-key',editorKey);
  await saveProject();
  try{
    const r=await fetch(`/api/render/${encodeURIComponent(slug)}`,{method:'POST',headers:{'X-Editor-Key':editorKey}});
    if(!r.ok) throw new Error(await r.text());
    const data=await r.json(); alert(`Render started. ${data.message||''}`);
  }catch(err){ alert(`Could not start render: ${err.message}`); }
}

$('playBtn').onclick=()=>playing?pause():play();
$('scrubber').oninput=e=>seek(+e.target.value);
$('zoomRange').oninput=e=>{pxPerSecond=+e.target.value; project.editor.pxPerSecond=pxPerSecond; renderTimeline();};
$('undoBtn').onclick=()=>{ if(!undoStack.length)return; project=undoStack.pop(); renderAll(); markDraft(); $('undoBtn').disabled=!undoStack.length; };
$('resetBtn').onclick=()=>{ if(!confirm('Reset the local draft to the last saved master?'))return; pushUndo(); project=clone(originalProject); localStorage.removeItem(localKey); selectedId=null; pxPerSecond=project.editor?.pxPerSecond||18; renderAll(); $('projectStatus').textContent='Master restored'; };
$('exportBtn').onclick=()=>{ const blob=new Blob([JSON.stringify(project,null,2)],{type:'application/json'}); const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${slug}.json`;a.click();URL.revokeObjectURL(a.href); };
$('importInput').onchange=async e=>{ const f=e.target.files?.[0]; if(!f)return; pushUndo(); project=JSON.parse(await f.text()); renderAll(); markDraft('Imported draft'); };
$('saveBtn').onclick=saveProject; $('renderBtn').onclick=requestRender;
$('pipWidth').oninput=e=>{project.pip.width=+e.target.value;syncPreview(Number($('scrubber').value),true);markDraft();};
$('pipBottom').oninput=e=>{project.pip.bottom=+e.target.value;syncPreview(Number($('scrubber').value),true);markDraft();};
$('pipMargin').oninput=e=>{project.pip.margin=+e.target.value;syncPreview(Number($('scrubber').value),true);markDraft();};
$('timelineCanvas').addEventListener('pointerdown',e=>{ if(e.target.closest('.clip'))return; const rect=$('visualTrack').getBoundingClientRect(); if(e.clientX<rect.left)return; seek((e.clientX-rect.left)/pxPerSecond); });
bindInspector();
loadProject().catch(err=>{document.body.innerHTML=`<pre style="padding:30px;color:#fff">${err.stack}</pre>`});
