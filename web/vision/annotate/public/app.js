// Logica dello strumento di annotazione. Vanilla JS, nessuna build: gira
// cosi' com'e' nel browser dell'utente.

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const btnAddFace = document.getElementById('btnAddFace');
const btnDiscard = document.getElementById('btnDiscard');
const btnSave = document.getElementById('btnSave');

const PALETTE = ['#f472b6', '#22d3ee', '#facc15', '#a3e635', '#38bdf8', '#fb923c'];
const HANDLE_RADIUS = 8;
const DELETE_RADIUS = 9;

let manifest = [];
let currentIndex = 0;
let faces = []; // [{ corners: [{x,y,visibility}] x4 }]
let image = null;
let addingFace = false;
let drag = null; // { faceIndex, pointIndex, moved }

function setStatus(text) { statusEl.textContent = text; }

function currentFrame() { return manifest[currentIndex]; }

function faceCentroid(face) {
  const cx = face.corners.reduce((sum, c) => sum + c.x, 0) / face.corners.length;
  const cy = face.corners.reduce((sum, c) => sum + c.y, 0) / face.corners.length;
  return { x: cx, y: cy };
}

function draw() {
  if (!image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  faces.forEach((face, faceIndex) => {
    const color = PALETTE[faceIndex % PALETTE.length];
    ctx.beginPath();
    face.corners.forEach((corner, index) => {
      if (index === 0) ctx.moveTo(corner.x, corner.y);
      else ctx.lineTo(corner.x, corner.y);
    });
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();

    face.corners.forEach((corner, index) => {
      ctx.beginPath();
      ctx.arc(corner.x, corner.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (corner.visibility === 1) {
        // occluso: anello tratteggiato invece di riempimento pieno
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, HANDLE_RADIUS + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
      }
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index), corner.x, corner.y - HANDLE_RADIUS - 10);
    });

    // pulsante elimina, vicino al centroide
    const centroid = faceCentroid(face);
    ctx.beginPath();
    ctx.arc(centroid.x, centroid.y, DELETE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#7f1d1d';
    ctx.fill();
    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fecaca';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillText('×', centroid.x, centroid.y + 1);
  });

  if (addingFace) {
    ctx.fillStyle = 'rgba(37,99,235,0.85)';
    ctx.fillRect(0, 0, canvas.width, 26);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('clicca sulla faccia da aggiungere...', 8, 13);
  }
}

function canvasPointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

function findHandleAt(point) {
  for (let f = faces.length - 1; f >= 0; f -= 1) {
    for (let p = 0; p < faces[f].corners.length; p += 1) {
      const corner = faces[f].corners[p];
      if (Math.hypot(corner.x - point.x, corner.y - point.y) <= HANDLE_RADIUS + 4) {
        return { faceIndex: f, pointIndex: p };
      }
    }
  }
  return null;
}

function findDeleteButtonAt(point) {
  for (let f = faces.length - 1; f >= 0; f -= 1) {
    const centroid = faceCentroid(faces[f]);
    if (Math.hypot(centroid.x - point.x, centroid.y - point.y) <= DELETE_RADIUS + 3) return f;
  }
  return null;
}

async function requestSamPrompt(x, y) {
  const frame = currentFrame();
  setStatus('interrogo SAM...');
  const response = await fetch(`/api/prompt/${frame.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x, y }),
  });
  const data = await response.json();
  setStatus('');
  return data.result;
}

canvas.addEventListener('mousedown', async (event) => {
  const point = canvasPointFromEvent(event);

  if (addingFace) {
    addingFace = false;
    draw();
    const result = await requestSamPrompt(point.x, point.y);
    if (result) {
      faces.push({ corners: result.corners.map((c) => ({ x: c.x, y: c.y, visibility: 2 })) });
    } else {
      setStatus('SAM non ha trovato nulla li\': aggiungi comunque 4 punti a mano trascinandoli da qui.');
      faces.push({ corners: [0, 1, 2, 3].map((i) => ({ x: point.x + i * 4 - 6, y: point.y + i * 4 - 6, visibility: 2 })) });
    }
    draw();
    return;
  }

  const deleteIndex = findDeleteButtonAt(point);
  if (deleteIndex !== null) {
    faces.splice(deleteIndex, 1);
    draw();
    return;
  }

  const handle = findHandleAt(point);
  if (handle) {
    drag = { ...handle, moved: false };
  }
});

canvas.addEventListener('mousemove', (event) => {
  if (!drag) return;
  const point = canvasPointFromEvent(event);
  const corner = faces[drag.faceIndex].corners[drag.pointIndex];
  corner.x = Math.max(0, Math.min(canvas.width, point.x));
  corner.y = Math.max(0, Math.min(canvas.height, point.y));
  drag.moved = true;
  draw();
});

window.addEventListener('mouseup', () => {
  if (drag && !drag.moved) {
    const corner = faces[drag.faceIndex].corners[drag.pointIndex];
    corner.visibility = corner.visibility === 2 ? 1 : 2;
    draw();
  }
  drag = null;
});

btnAddFace.addEventListener('click', () => {
  addingFace = true;
  draw();
});

btnDiscard.addEventListener('click', async () => {
  await saveCurrent(true);
  goTo(currentIndex + 1);
});

btnSave.addEventListener('click', async () => {
  await saveCurrent(false);
  goTo(currentIndex + 1);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { btnSave.click(); }
  else if (event.key === 'ArrowRight') { goTo(currentIndex + 1); }
  else if (event.key === 'ArrowLeft') { goTo(currentIndex - 1); }
});

async function saveCurrent(discarded) {
  const frame = currentFrame();
  setStatus('salvo...');
  await fetch(`/api/save/${frame.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ faces, discarded, width: canvas.width, height: canvas.height }),
  });
  frame.annotated = true;
  setStatus('');
  updateProgress();
}

function updateProgress() {
  const done = manifest.filter((f) => f.annotated).length;
  progressEl.textContent = `${currentIndex + 1} / ${manifest.length} · ${done} annotati · ${currentFrame().video} @ ${currentFrame().time.toFixed(1)}s (${currentFrame().split})`;
}

async function loadFrame(index) {
  if (index < 0 || index >= manifest.length) return;
  currentIndex = index;
  addingFace = false;
  drag = null;
  const frame = currentFrame();
  updateProgress();
  setStatus('carico...');

  image = new Image();
  await new Promise((resolve) => {
    image.onload = resolve;
    image.src = `/frames/${frame.id}.jpg`;
  });
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const saved = await fetch(`/api/label/${frame.id}`).then((r) => r.json());
  if (saved) {
    faces = saved.faces;
    setStatus(saved.discarded ? 'fotogramma gia\' scartato in precedenza' : 'annotazione precedente ricaricata');
  } else {
    setStatus('pre-annotazione automatica (SAM, punto centrale)...');
    const auto = await fetch(`/api/auto/${frame.id}`, { method: 'POST' }).then((r) => r.json());
    faces = auto.result
      ? [{ corners: auto.result.corners.map((c) => ({ x: c.x, y: c.y, visibility: 2 })) }]
      : [];
    setStatus(auto.result ? '' : 'SAM non ha trovato nulla al centro: aggiungi le facce a mano con "+ nuova faccia"');
  }
  draw();
}

function goTo(index) {
  const clamped = Math.max(0, Math.min(manifest.length - 1, index));
  loadFrame(clamped);
}

async function init() {
  manifest = await fetch('/api/manifest').then((r) => r.json());
  hintEl.textContent = `${manifest.length} fotogrammi in coda.`;
  await loadFrame(0);
}

init();
