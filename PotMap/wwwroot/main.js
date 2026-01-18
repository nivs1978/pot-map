const mapImage = document.getElementById("mapImage");
const mapViewport = document.getElementById("mapViewport");
const mapContent = document.getElementById("mapContent");
const poiLayer = document.getElementById("poiLayer");
const tileLayerElement = document.getElementById("tileLayer");
const statusReadout = document.getElementById("statusReadout");
const trashCan = document.getElementById("trashCan");
const editModeToggle = document.getElementById("editModeToggle");

const API_ENDPOINT = "/api/data";
const MAP_ID_HEX = "f1a07941faef496095bf69e01705bc6a";
const VISITED_STORAGE_KEY = `poiVisited_${MAP_ID_HEX}`;
const MARKER_MIN_SIZE_VH = 1.25;
const MARKER_MAX_SIZE_VH = 4.0;
const DRAG_GHOST_SIZE_MULTIPLIER = 1.25;
const VISITED_OPACITY = 0.5;
const ORIGINAL_MAP_WIDTH = 9400;
const ORIGINAL_MAP_HEIGHT = 9400;
const TILE_SIZE = 256;
const TILE_EXTENSION = "jpg";
const ACCESS_PROMPT_MESSAGE = "Enter the access password to manage POIs:";
const ACCESS_DENIED_ALERT = "Access denied. Please enter the password again.";
const MAX_ACCESS_RETRY_ATTEMPTS = 2;
const MAX_ZOOM_MULTIPLIER = 32;

let code = null;

const PoiCatalog = {};

const state = {
  scale: 1,
  translateX: 0,
  translateY: 0,
  mapWidth: 0,
  mapHeight: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  fitScale: 1,
  minScale: 0.2,
  maxScale: MAX_ZOOM_MULTIPLIER,
  initialized: false,
};

const pointerTracker = new Map();
const renderedPoiIds = new Set();
let panSession = null;
let pinchSession = null;
let dragState = null;
const hiddenTypes = new Set();
const visitedPoiIds = new Set(loadVisitedPoiIds());
let editMode = false;
let tileLayer = tileLayerElement || null;
const tileCache = new Map();
let currentTileZoom = null;
let tileLoadSessionId = 0;

function getMapName() {
  // Prefer an explicit map name on the tileLayer or mapImage elements, fall back to MAP_ID_HEX.
  try {
    const fromCreatedTileLayer = tileLayer?.dataset?.mapname;
    if (fromCreatedTileLayer) return String(fromCreatedTileLayer);
    const fromTileElement = tileLayerElement?.dataset?.mapname;
    if (fromTileElement) return String(fromTileElement);
    const fromImage = mapImage?.dataset?.mapname;
    if (fromImage) return String(fromImage);
    const src = mapImage?.getAttribute?.('src') || '';
    if (src) {
      const filename = src.split('/').pop() || '';
      const name = filename.split('.').slice(0, -1).join('.') || filename;
      if (name) return name;
    }
  } catch (e) {
    // ignore
  }
  return MAP_ID_HEX;
}

if ((mapImage.complete && mapImage.naturalWidth) || hasDeclaredDimensions()) {
  handleImageReady();
} else {
  mapImage.addEventListener("load", handleImageReady);
}

window.addEventListener("resize", handleResize);
mapViewport.addEventListener("wheel", handleWheel, { passive: false });
mapViewport.addEventListener("pointerdown", handlePointerDown);
mapViewport.addEventListener("pointermove", handlePointerMove);
mapViewport.addEventListener("pointerup", handlePointerEnd);
mapViewport.addEventListener("pointercancel", handlePointerEnd);

initializePoiInterface();
initializeEditControls();
syncVisitedOpacityVariable();

// Lock the interactive canvas to the intrinsic map size once the texture loads.
function handleImageReady() {
  const declaredWidth = getDeclaredDimension("mapwidth");
  const declaredHeight = getDeclaredDimension("mapheight");
  // If the source image is still present use its intrinsic size; otherwise fall back to the original
  // full-map dimensions so coordinates (percent of image) remain consistent with the generated tiles.
  const fallbackWidth = mapImage.naturalWidth || ORIGINAL_MAP_WIDTH;
  const fallbackHeight = mapImage.naturalHeight || ORIGINAL_MAP_HEIGHT;
  state.mapWidth = declaredWidth ?? fallbackWidth;
  state.mapHeight = declaredHeight ?? fallbackHeight;
  if (!state.mapWidth || !state.mapHeight) {
    return;
  }

  // Hide the original single-source image when using tiles (it may still exist in the DOM).
  if (mapImage) {
    try {
      mapImage.style.display = "none";
      mapImage.style.width = "0px";
      mapImage.style.height = "0px";
    } catch (e) {
      // ignore
    }
  }

  // Ensure map content and POI layer use the original full-map pixel dimensions so normalized coords still work.
  mapContent.style.width = `${state.mapWidth}px`;
  mapContent.style.height = `${state.mapHeight}px`;
  poiLayer.style.width = `${state.mapWidth}px`;
  poiLayer.style.height = `${state.mapHeight}px`;

  // Create tile layer container if it does not exist
  if (!tileLayer) {
    tileLayer = document.createElement("div");
    tileLayer.id = "tileLayer";
    tileLayer.style.position = "absolute";
    tileLayer.style.left = "0px";
    tileLayer.style.top = "0px";
    tileLayer.style.width = `${state.mapWidth}px`;
    tileLayer.style.height = `${state.mapHeight}px`;
    // Insert tile layer before the POI layer if that's a child of mapContent, otherwise append.
    if (poiLayer && poiLayer.parentElement === mapContent) {
      mapContent.insertBefore(tileLayer, poiLayer);
    } else {
      mapContent.appendChild(tileLayer);
    }
  } else {
    tileLayer.style.width = `${state.mapWidth}px`;
    tileLayer.style.height = `${state.mapHeight}px`;
  }

  handleResize();
  refreshMarkerPositions();
  refreshTiles();
}

function hasDeclaredDimensions() {
  return (
    getDeclaredDimension("mapwidth") !== null &&
    getDeclaredDimension("mapheight") !== null
  );
}

function getDeclaredDimension(attrName) {
  if (!mapImage?.getAttribute) {
    return null;
  }
  const raw = mapImage.getAttribute(`data-${attrName}`);
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

// Recalculate viewport bounds and fit/center the map when needed.
function handleResize() {
  state.viewportWidth = mapViewport.clientWidth;
  state.viewportHeight = mapViewport.clientHeight;
  if (!state.mapWidth || !state.mapHeight) {
    return;
  }

  if (!state.initialized) {
    const fitScale = Math.min(
      state.viewportWidth / state.mapWidth,
      state.viewportHeight / state.mapHeight
    );
    state.fitScale = fitScale;
    state.scale = fitScale;
    state.minScale = Math.max(fitScale * 0.4, 0.05);
    state.maxScale = fitScale * MAX_ZOOM_MULTIPLIER;
    centerMap();
    state.initialized = true;
  } else {
    clampTranslation();
  }

  applyTransform();
}

function centerMap() {
  const scaledWidth = state.mapWidth * state.scale;
  const scaledHeight = state.mapHeight * state.scale;
  state.translateX = (state.viewportWidth - scaledWidth) / 2;
  state.translateY = (state.viewportHeight - scaledHeight) / 2;
}

// Keep the map anchored so users cannot pan it completely off-screen.
function clampTranslation() {
  const scaledWidth = state.mapWidth * state.scale;
  const scaledHeight = state.mapHeight * state.scale;

  if (scaledWidth <= state.viewportWidth) {
    state.translateX = (state.viewportWidth - scaledWidth) / 2;
  } else {
    const minX = state.viewportWidth - scaledWidth;
    const maxX = 0;
    state.translateX = clamp(state.translateX, minX, maxX);
  }

  if (scaledHeight <= state.viewportHeight) {
    state.translateY = (state.viewportHeight - scaledHeight) / 2;
  } else {
    const minY = state.viewportHeight - scaledHeight;
    const maxY = 0;
    state.translateY = clamp(state.translateY, minY, maxY);
  }
}

// Smooth zoom driven by the scroll wheel (or trackpad) around the cursor.
function handleWheel(event) {
  if (!state.initialized) {
    return;
  }

  event.preventDefault();
  const zoomFactor = Math.exp(-event.deltaY * 0.01);
  const targetScale = state.scale * zoomFactor;
  setScaleAround(targetScale, event.clientX, event.clientY);
  applyTransform();
}

// Begin panning or prepare for a pinch when the user presses on the map.
function handlePointerDown(event) {
  if (!state.initialized) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  event.preventDefault();
  mapViewport.setPointerCapture(event.pointerId);
  pointerTracker.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });

  if (pointerTracker.size === 1) {
    panSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.translateX,
      originY: state.translateY,
    };
  } else if (pointerTracker.size === 2) {
    startPinchSession();
  }
}

// Update pan or pinch interactions as pointers move across the viewport.
function handlePointerMove(event) {
  if (!pointerTracker.has(event.pointerId)) {
    return;
  }

  pointerTracker.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });

  if (pointerTracker.size === 1 && panSession && panSession.pointerId === event.pointerId) {
    const deltaX = event.clientX - panSession.startX;
    const deltaY = event.clientY - panSession.startY;
    state.translateX = panSession.originX + deltaX;
    state.translateY = panSession.originY + deltaY;
    clampTranslation();
    applyTransform();
    return;
  }

  if (pointerTracker.size >= 2 && pinchSession) {
    applyPinchTransform();
  }
}

function handlePointerEnd(event) {
  if (pointerTracker.has(event.pointerId)) {
    pointerTracker.delete(event.pointerId);
    try {
      mapViewport.releasePointerCapture(event.pointerId);
    } catch (err) {
      // Ignore capture release errors.
    }
  }

  if (pointerTracker.size === 1) {
    const iterator = pointerTracker.entries().next();
    if (iterator.done) {
      panSession = null;
      pinchSession = null;
      return;
    }
    const [id, point] = iterator.value;
    panSession = {
      pointerId: id,
      startX: point.clientX,
      startY: point.clientY,
      originX: state.translateX,
      originY: state.translateY,
    };
    pinchSession = null;
  } else if (pointerTracker.size >= 2) {
    startPinchSession();
  } else {
    panSession = null;
    pinchSession = null;
  }
}

// Initialize pinch tracking with the first two active pointers.
function startPinchSession() {
  if (pointerTracker.size < 2) {
    pinchSession = null;
    return;
  }

  const entries = Array.from(pointerTracker.entries()).slice(0, 2);
  const points = entries.map(([, point]) => point);
  const midpoint = getMidpoint(points[0], points[1]);

  pinchSession = {
    startDistance: getDistance(points[0], points[1]),
    startScale: state.scale,
    prevMidpoint: midpoint,
  };
}

// Apply pinch zoom + translation using the active pair of touch points.
function applyPinchTransform() {
  const entries = Array.from(pointerTracker.values()).slice(0, 2);
  if (entries.length < 2 || !pinchSession) {
    return;
  }

  const [first, second] = entries;
  const distance = getDistance(first, second);
  if (pinchSession.startDistance <= 0) {
    return;
  }

  const midpoint = getMidpoint(first, second);
  const rawScale = pinchSession.startScale * (distance / pinchSession.startDistance);
  setScaleAround(rawScale, midpoint.clientX, midpoint.clientY);

  if (pinchSession.prevMidpoint) {
    const dx = midpoint.clientX - pinchSession.prevMidpoint.clientX;
    const dy = midpoint.clientY - pinchSession.prevMidpoint.clientY;
    state.translateX += dx;
    state.translateY += dy;
    clampTranslation();
  }

  pinchSession.prevMidpoint = midpoint;
  applyTransform();
}

function setScaleAround(targetScale, clientX, clientY) {
  const rect = mapViewport.getBoundingClientRect();
  const offsetX = clamp(clientX - rect.left, 0, rect.width);
  const offsetY = clamp(clientY - rect.top, 0, rect.height);
  const mapX = (offsetX - state.translateX) / state.scale;
  const mapY = (offsetY - state.translateY) / state.scale;

  state.scale = clamp(targetScale, state.minScale, state.maxScale);
  state.translateX = offsetX - mapX * state.scale;
  state.translateY = offsetY - mapY * state.scale;
  clampTranslation();
}

function applyTransform() {
  mapContent.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
  updateStatus();
  syncGhostSizeWithScale();
  refreshMarkerPositions();
  refreshTiles();
}

function getTileZoomForScale() {
  // Determine appropriate tile zoom based on absolute map scale.
  // baseZoom corresponds to full resolution index (largest image) produced by the tile generator.
  if (!state.mapWidth) return 0;
  const tilesNeeded = state.mapWidth / TILE_SIZE;
  const baseZoom = Math.max(0, Math.ceil(Math.log2(Math.max(1, tilesNeeded))));

  // Choose zoom so that image pixel -> screen pixel ratio is near 1:1.
  // Derivation: zoom ~= baseZoom + log2(state.scale)
  const zoomFloat = baseZoom + Math.log2(Math.max(Number.EPSILON, state.scale));
  const zoom = clamp(Math.round(zoomFloat), 0, baseZoom);
  return zoom;
}

function getVisibleMapRect() {
  // Returns visible rectangle in map pixel coordinates
  const left = (0 - state.translateX) / state.scale;
  const top = (0 - state.translateY) / state.scale;
  const right = (state.viewportWidth - state.translateX) / state.scale;
  const bottom = (state.viewportHeight - state.translateY) / state.scale;
  return {
    left: clamp(left, 0, state.mapWidth),
    top: clamp(top, 0, state.mapHeight),
    right: clamp(right, 0, state.mapWidth),
    bottom: clamp(bottom, 0, state.mapHeight),
  };
}

function refreshTiles() {
  if (!tileLayer || !isMapReady()) return;
  const zoom = getTileZoomForScale();

  // Compute base zoom and placement math
  const baseZoom = Math.max(0, Math.ceil(Math.log2(Math.max(1, state.mapWidth / TILE_SIZE))));
  const levelScale = Math.pow(2, baseZoom - zoom);
  const levelImageWidth = Math.ceil(state.mapWidth / levelScale);
  const levelImageHeight = Math.ceil(state.mapHeight / levelScale);
  const tilesPerAxisX = Math.max(1, Math.ceil(levelImageWidth / TILE_SIZE));
  const tilesPerAxisY = Math.max(1, Math.ceil(levelImageHeight / TILE_SIZE));
  const fullTileOriginalPx = TILE_SIZE * levelScale;

  const visible = getVisibleMapRect();
  const startX = clamp(Math.floor(visible.left / fullTileOriginalPx), 0, tilesPerAxisX - 1);
  const endX = clamp(Math.floor((visible.right - 1) / fullTileOriginalPx), 0, tilesPerAxisX - 1);
  const startY = clamp(Math.floor(visible.top / fullTileOriginalPx), 0, tilesPerAxisY - 1);
  const endY = clamp(Math.floor((visible.bottom - 1) / fullTileOriginalPx), 0, tilesPerAxisY - 1);

  const needed = new Set();
  const mapName = getMapName();
  try { console.debug && console.debug(`Tile layer map name: ${mapName}, zoom ${zoom}`); } catch (e) {}

  // If this is the initial load (no current zoom) populate the existing tileLayer.
  if (currentTileZoom === null) {
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        const key = `${zoom}_${x}_${y}`;
        needed.add(key);
        if (tileCache.has(key)) continue;
        const img = document.createElement('img');
        img.className = 'map-tile';
        img.style.position = 'absolute';
        const leftPx = Math.round(x * fullTileOriginalPx);
        const topPx = Math.round(y * fullTileOriginalPx);
        const sizePx = Math.round(fullTileOriginalPx);
        const overlap = 1;
        img.style.left = `${leftPx}px`;
        img.style.top = `${topPx}px`;
        img.style.width = `${sizePx + overlap}px`;
        img.style.height = `${sizePx + overlap}px`;
        img.draggable = false;
        img.alt = '';
        const tileSrc = buildTileSrc(mapName, zoom, x, y);
        img.onerror = () => {
          img.style.display = 'none';
          logTileLoadFailure(tileSrc, zoom, x, y);
        };
        img.src = tileSrc;
        tileLayer.appendChild(img);
        tileCache.set(key, img);
      }
    }
    currentTileZoom = zoom;
    return;
  }

  // If zoom unchanged, ensure tiles for the visible area exist and remove unneeded
  if (zoom === currentTileZoom) {
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        const key = `${zoom}_${x}_${y}`;
        needed.add(key);
        if (tileCache.has(key)) continue;
        const img = document.createElement('img');
        img.className = 'map-tile';
        img.style.position = 'absolute';
        const leftPx = Math.round(x * fullTileOriginalPx);
        const topPx = Math.round(y * fullTileOriginalPx);
        const sizePx = Math.round(fullTileOriginalPx);
        const overlap = 1;
        img.style.left = `${leftPx}px`;
        img.style.top = `${topPx}px`;
        img.style.width = `${sizePx + overlap}px`;
        img.style.height = `${sizePx + overlap}px`;
        img.draggable = false;
        img.alt = '';
        const tileSrc = buildTileSrc(mapName, zoom, x, y);
        img.onerror = () => {
          img.style.display = 'none';
          logTileLoadFailure(tileSrc, zoom, x, y);
        };
        img.src = tileSrc;
        tileLayer.appendChild(img);
        tileCache.set(key, img);
      }
    }
    // remove tiles not needed
    Array.from(tileCache.keys()).forEach((key) => {
      if (!needed.has(key)) {
        const el = tileCache.get(key);
        try { el.remove(); } catch (e) {}
        tileCache.delete(key);
      }
    });
    return;
  }

  // Zoom changed: load new tiles in a hidden overlay layer, then swap without clearing the old layer
  tileLoadSessionId += 1;
  const sessionId = tileLoadSessionId;
  const newLayer = document.createElement('div');
  newLayer.style.position = 'absolute';
  newLayer.style.left = '0px';
  newLayer.style.top = '0px';
  newLayer.style.width = `${state.mapWidth}px`;
  newLayer.style.height = `${state.mapHeight}px`;
  newLayer.style.pointerEvents = 'none';
  newLayer.style.visibility = 'hidden'; // keep hidden until fully loaded
  // insert on top of existing tileLayer but below poiLayer (guard if poiLayer isn't a child)
  if (poiLayer && poiLayer.parentElement === mapContent) {
    mapContent.insertBefore(newLayer, poiLayer);
  } else {
    mapContent.appendChild(newLayer);
  }

  const newCache = new Map();
  const loadPromises = [];
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const key = `${zoom}_${x}_${y}`;
      needed.add(key);
      const img = document.createElement('img');
      img.className = 'map-tile';
      img.style.position = 'absolute';
      const leftPx = Math.round(x * fullTileOriginalPx);
      const topPx = Math.round(y * fullTileOriginalPx);
      const sizePx = Math.round(fullTileOriginalPx);
      const overlap = 1;
      img.style.left = `${leftPx}px`;
      img.style.top = `${topPx}px`;
      img.style.width = `${sizePx + overlap}px`;
      img.style.height = `${sizePx + overlap}px`;
      img.draggable = false;
      img.alt = '';
      const p = new Promise((resolve) => {
        let settled = false;
        const tileSrc = buildTileSrc(mapName, zoom, x, y);
        img.onload = () => { if (!settled) { settled = true; resolve({ img, ok: true }); } };
        img.onerror = () => {
          if (!settled) {
            settled = true;
            logTileLoadFailure(tileSrc, zoom, x, y);
            resolve({ img, ok: false });
          }
        };
        img.src = tileSrc;
      });
      newLayer.appendChild(img);
      newCache.set(key, img);
      loadPromises.push(p);
    }
  }

  Promise.allSettled(loadPromises).then(() => {
    if (sessionId !== tileLoadSessionId) {
      // a newer session started; discard this layer
      try { newLayer.remove(); } catch (e) {}
      return;
    }
    // Show the new layer, remove the old one and replace caches
    newLayer.style.visibility = '';
    // remove old tiles and layer
    tileCache.forEach((el) => { try { el.remove(); } catch (e) {} });
    tileCache.clear();
    try { if (tileLayer && tileLayer.parentElement === mapContent) tileLayer.remove(); } catch (e) {}
    // adopt new layer as tileLayer
    newLayer.id = 'tileLayer';
    tileLayer = newLayer;
    newCache.forEach((v, k) => tileCache.set(k, v));
    currentTileZoom = zoom;
  });
}

function buildTileSrc(mapName, zoom, x, y) {
  return `/tiles/${mapName}/${zoom}/${x}_${y}.${TILE_EXTENSION}`;
}

function logTileLoadFailure(src, zoom, x, y) {
  const message = `[tiles] Failed to load tile (zoom=${zoom}, x=${x}, y=${y}) from ${src}`;
  if (console && typeof console.error === "function") {
    console.error(message);
  } else if (console && typeof console.log === "function") {
    console.log(message);
  }
}

function syncGhostSizeWithScale() {
  const sizePx = `${Math.round(getMarkerSizePx())}px`;
  document.documentElement.style.setProperty("--poi-marker-size", sizePx);
  poiLayer.querySelectorAll(".poi-marker").forEach((marker) => {
    marker.style.width = sizePx;
    marker.style.height = sizePx;
  });
  if (dragState?.ghost) {
    const ghostSize = `${Math.round(getDragGhostSizePx())}px`;
    dragState.ghost.style.width = ghostSize;
    dragState.ghost.style.height = ghostSize;
  }
}

function getMarkerSizePx() {
  const viewportHeight = state.viewportHeight || mapViewport.clientHeight || window.innerHeight || 0;
  const minPx = Math.max(12, (MARKER_MIN_SIZE_VH / 100) * viewportHeight);
  const maxPx = Math.max(minPx, (MARKER_MAX_SIZE_VH / 100) * viewportHeight);
  return lerp(minPx, maxPx, getZoomProgress());
}

function getDragGhostSizePx() {
  return getMarkerSizePx() * DRAG_GHOST_SIZE_MULTIPLIER;
}

function getZoomProgress() {
  if (!isMapReady()) {
    return 0;
  }
  const range = state.maxScale - state.minScale;
  if (!(range > 0)) {
    return 0;
  }
  const progress = (state.scale - state.minScale) / range;
  return clamp(progress, 0, 1);
}

function updateStatus() {
  if (!statusReadout || !state.fitScale) {
    return;
  }
  const percent = Math.round((state.scale / state.fitScale) * 100);
  statusReadout.textContent = `Scale ${percent}%`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function getDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function getMidpoint(a, b) {
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  };
}

function setupToolbar() {
  const root = getToolbarRoot();
  if (root) {
    renderToolbarIcons(root);
    return;
  }
  bindToolbarPointerHandlers(document.querySelectorAll(".poi-icon"));
}

function getToolbarRoot() {
  return document.querySelector("[data-poi-toolbar]") || document.getElementById("poiToolbar");
}

function renderToolbarIcons(container) {
  container.innerHTML = "";
  const fragment = document.createDocumentFragment();
  const entries = Object.entries(PoiCatalog).sort(([, a], [, b]) =>
    (a?.label || "").localeCompare(b?.label || "", undefined, { sensitivity: "base" })
  );
  entries.forEach(([type, asset]) => {
    if (!asset?.src) {
      return;
    }
    const icon = document.createElement("img");
    icon.className = "poi-icon";
    icon.dataset.type = String(type);
    icon.src = asset.src;
    icon.alt = asset.label || "";
    icon.title = asset.label || "";
    applyIconVisibility(icon);
    fragment.appendChild(icon);
  });
  container.appendChild(fragment);
  bindToolbarPointerHandlers(container.querySelectorAll(".poi-icon"));
}

function toggleTypeVisibility(type) {
  const numericType = Number(type);
  if (!Number.isFinite(numericType)) {
    return;
  }
  if (hiddenTypes.has(numericType)) {
    hiddenTypes.delete(numericType);
  } else {
    hiddenTypes.add(numericType);
  }
  updateVisibilityForType(numericType);
}

function updateVisibilityForType(type) {
  const selector = `.poi-icon[data-type="${type}"]`;
  document.querySelectorAll(selector).forEach(applyIconVisibility);
  poiLayer
    .querySelectorAll(`.poi-marker[data-type="${type}"]`)
    .forEach((marker) => applyMarkerVisibility(marker));
}

function applyIconVisibility(icon) {
  if (!(icon instanceof HTMLElement)) {
    return;
  }
  const type = Number(icon.dataset?.type);
  if (!Number.isFinite(type)) {
    return;
  }
  const hidden = !editMode && hiddenTypes.has(type);
  icon.classList.toggle("poi-icon--muted", hidden);
}

function bindToolbarPointerHandlers(icons) {
  icons.forEach((icon) => {
    icon.addEventListener("pointerdown", handleToolbarIconPointerDown);
    icon.addEventListener("click", handleToolbarIconClick);
    icon.addEventListener("dragstart", preventNativeDrag);
  });
}

function handleToolbarIconPointerDown(event) {
  if (!(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  const type = Number(event.currentTarget.dataset?.type);
  if (!Number.isFinite(type)) {
    return;
  }
  if (!editMode) {
    return;
  }
  startIconDrag(event.currentTarget, event);
}

function handleToolbarIconClick(event) {
  if (editMode || !(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  const type = Number(event.currentTarget.dataset?.type);
  if (!Number.isFinite(type)) {
    return;
  }
  event.preventDefault();
  toggleTypeVisibility(type);
}

function preventNativeDrag(event) {
  event.preventDefault();
}

async function initializePoiInterface() {
  await initializePoiCatalog();
  setupToolbar();
  fetchExistingPois();
}

function initializeEditControls() {
  setEditMode(false);
  if (editModeToggle) {
    editModeToggle.addEventListener("click", handleEditToggleClick);
  }
}

function handleEditToggleClick() {
  setEditMode(!editMode);
}

function setEditMode(enabled) {
  const nextMode = Boolean(enabled);
  if (nextMode !== editMode) {
    editMode = nextMode;
    if (!editMode && dragState) {
      endDrag();
    }
  }
  document.body?.classList.toggle("mode-edit", editMode);
  document.body?.classList.toggle("mode-view", !editMode);
  updateEditToggleUI();
  refreshVisibilityFilters();
}

function updateEditToggleUI() {
  if (!editModeToggle) {
    return;
  }
  editModeToggle.classList.toggle("mode-toggle--active", editMode);
  editModeToggle.setAttribute("aria-pressed", String(editMode));
  const label = editMode ? "Switch to view mode" : "Switch to edit mode";
  editModeToggle.setAttribute("aria-label", label);
  editModeToggle.setAttribute("title", label);
}

async function initializePoiCatalog() {
  const remoteEntries = await fetchPoiTypesFromServer();
  if (Array.isArray(remoteEntries) && remoteEntries.length) {
    hydratePoiCatalog(remoteEntries);
  }
}

async function fetchPoiTypesFromServer() {
  try {
    const payload = await postToApi({ action: "types" });
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return rows
      .map((row) => ({
        id: Number(row.id ?? row.type_id ?? row.typeId),
        label: row.name || row.label || "",
        src: withResourcePrefix(row.image || row.src || ""),
      }))
      .filter((entry) => Number.isFinite(entry.id) && entry.label && entry.src);
  } catch (error) {
    console.error("Failed to load POI types", error);
    return null;
  }
}

function withResourcePrefix(src) {
  if (!src) {
    return "";
  }
  const trimmed = src.trim();
  if (
    trimmed.startsWith("graphics/") ||
    trimmed.startsWith("/") ||
    /^https?:\/\//i.test(trimmed)
  ) {
    return trimmed;
  }
  return `graphics/resources/${trimmed}`;
}

function hydratePoiCatalog(records) {
  Object.keys(PoiCatalog).forEach((key) => delete PoiCatalog[key]);
  records.forEach(({ id, label, src }) => {
    PoiCatalog[id] = { label, src };
  });
}

async function postToApi(payload, options = {}) {
  const { requireCode = false, attempt = 0 } = options;
  const requestPayload = { ...payload };
  if (requireCode) {
    const accessCode = await ensureAccessCode();
    if (!accessCode) {
      throw new Error("Access code is required");
    }
    requestPayload.code = accessCode;
  }
  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });
  if (response.status === 403 && requireCode) {
    resetAccessCode();
    if (attempt < MAX_ACCESS_RETRY_ATTEMPTS) {
      alert(ACCESS_DENIED_ALERT);
      return postToApi(payload, { requireCode, attempt: attempt + 1 });
    }
    throw new Error("Access denied");
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function ensureAccessCode() {
  if (typeof code === "string" && code.trim()) {
    return code;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const input = window.prompt(ACCESS_PROMPT_MESSAGE) || "";
  const trimmed = input.trim();
  code = trimmed || null;
  return code;
}

function resetAccessCode() {
  code = null;
}

async function fetchExistingPois() {
  try {
    const payload = await postToApi({ action: "list", mapId: MAP_ID_HEX });
    renderPois(Array.isArray(payload?.data) ? payload.data : []);
  } catch (error) {
    console.error("Failed to load POIs", error);
  }
}

function renderPois(records) {
  if (!Array.isArray(records)) {
    return;
  }
  records.forEach(renderPoiMarker);
}

function renderPoiMarker(rawPoi) {
  const poi = normalizePoiRecord(rawPoi);
  if (!poi) {
    return;
  }
  const poiId = poi.id;
  if (!poiId || renderedPoiIds.has(poiId)) {
    return;
  }
  const marker = document.createElement("img");
  marker.className = "poi-marker";
  marker.dataset.id = poiId;
  marker.dataset.type = String(poi.type);
  marker.dataset.x = String(poi.x);
  marker.dataset.y = String(poi.y);
  const asset = PoiCatalog[poi.type];
  if (asset?.src) {
    marker.src = asset.src;
    marker.alt = asset.label || "";
    marker.title = asset.label || "";
  }
  positionMarker(marker);
  applyMarkerVisibility(marker);
  applyMarkerVisitedState(marker);
  bindMarkerInteractions(marker);
  poiLayer.appendChild(marker);
  renderedPoiIds.add(poiId);
}

function positionMarker(marker) {
  const coords = getMarkerStoredCoords(marker);
  if (!coords) {
    return;
  }
  const screenPosition = projectCoordsToScreen(coords);
  if (!screenPosition) {
    return;
  }
  marker.style.position = "absolute";
  marker.style.transform = "translate(-50%, -50%)";
  marker.style.left = `${screenPosition.left}px`;
  marker.style.top = `${screenPosition.top}px`;
  const sizePx = `${Math.round(getMarkerSizePx())}px`;
  marker.style.width = sizePx;
  marker.style.height = sizePx;
}

function getMarkerStoredCoords(marker) {
  const x = Number(marker.dataset?.x);
  const y = Number(marker.dataset?.y);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return null;
  }
  return { x, y };
}

function applyMarkerVisibility(marker) {
  if (!(marker instanceof HTMLElement)) {
    return;
  }
  const type = Number(marker.dataset?.type);
  if (!Number.isFinite(type)) {
    return;
  }
  const hidden = !editMode && hiddenTypes.has(type);
  marker.classList.toggle("poi-marker--hidden", hidden);
}

function refreshVisibilityFilters() {
  document.querySelectorAll(".poi-icon").forEach(applyIconVisibility);
  poiLayer
    .querySelectorAll(".poi-marker")
    .forEach((marker) => {
      applyMarkerVisibility(marker);
      applyMarkerVisitedState(marker);
    });
}

function applyMarkerVisitedState(marker) {
  const poiId = getMarkerId(marker);
  if (!poiId) {
    marker?.classList.remove("poi-marker--visited");
    return;
  }
  marker.classList.toggle("poi-marker--visited", visitedPoiIds.has(poiId));
}

function toggleMarkerVisited(marker) {
  if (!(marker instanceof HTMLElement)) {
    return;
  }
  const poiId = getMarkerId(marker);
  if (!poiId) {
    return;
  }
  const nextVisited = !visitedPoiIds.has(poiId);
  setMarkerVisited(marker, nextVisited);
}

function setMarkerVisited(marker, visited) {
  if (!(marker instanceof HTMLElement)) {
    return;
  }
  const poiId = getMarkerId(marker);
  if (!poiId) {
    return;
  }
  if (visited) {
    visitedPoiIds.add(poiId);
  } else {
    visitedPoiIds.delete(poiId);
  }
  marker.classList.toggle("poi-marker--visited", visited);
  persistVisitedState();
}

function getMarkerId(marker) {
  const raw = marker?.dataset?.id;
  if (!raw) {
    return null;
  }
  const normalized = String(raw).toLowerCase();
  return normalized ? normalized : null;
}

function toPixelCoords(x = 0, y = 0) {
  const normalized = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  return {
    left: normalized ? x * state.mapWidth : x,
    top: normalized ? y * state.mapHeight : y,
  };
}

function projectCoordsToScreen(coords) {
  if (!coords || !isMapReady()) {
    return null;
  }
  const { left, top } = toPixelCoords(coords.x, coords.y);
  return {
    left: state.translateX + left * state.scale,
    top: state.translateY + top * state.scale,
  };
}

function refreshMarkerPositions() {
  if (!isMapReady()) {
    return;
  }
  poiLayer.querySelectorAll(".poi-marker").forEach(positionMarker);
}

function bindMarkerInteractions(marker) {
  marker.addEventListener("pointerdown", handleMarkerPointerDown);
  marker.addEventListener("click", handleMarkerClick);
  marker.addEventListener("dragstart", preventNativeDrag);
}

function handleMarkerPointerDown(event) {
  if (!(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  if (!editMode) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  startMarkerDrag(event.currentTarget, event);
}

function handleMarkerClick(event) {
  if (!(event.currentTarget instanceof HTMLElement) || editMode) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  toggleMarkerVisited(event.currentTarget);
}

function startMarkerDrag(marker, event) {
  if (!isMapReady() || !editMode) {
    return;
  }
  const poiId = marker.dataset?.id;
  const coords = getMarkerStoredCoords(marker);
  if (!poiId || !coords) {
    return;
  }
  event.preventDefault();
  if (dragState) {
    endDrag();
  }
  try {
    marker.setPointerCapture(event.pointerId);
  } catch (error) {
    // Ignore pointer capture failures.
  }
  const label = marker.title || marker.alt || "";
  dragState = {
    mode: "move",
    pointerId: event.pointerId,
    marker,
    type: Number(marker.dataset?.type),
    id: poiId,
    initialCoords: coords,
    originalMarkerOpacity: marker.style.opacity,
    sourceElement: marker,
    ghost: createDragGhost(marker.src, label, getDragGhostSizePx()),
  };
  marker.style.opacity = "0";
  updateDragGhostPosition({ clientX: event.clientX, clientY: event.clientY });
  attachDragListeners();
}

function setTrashActive(active) {
  if (!trashCan) {
    return;
  }
  trashCan.classList.toggle("trash-can--active", Boolean(active));
}

function applyMarkerCoords(marker, coords) {
  const x = Number(coords?.x);
  const y = Number(coords?.y);
  if (!marker || Number.isNaN(x) || Number.isNaN(y)) {
    return;
  }
  marker.dataset.x = String(x);
  marker.dataset.y = String(y);
  positionMarker(marker);
  applyMarkerVisibility(marker);
  applyMarkerVisitedState(marker);
}

function revertMarkerPosition(snapshot) {
  if (!snapshot?.marker || !snapshot.initialCoords) {
    return;
  }
  applyMarkerCoords(snapshot.marker, snapshot.initialCoords);
}

async function commitMarkerMove(snapshot, clientPoint) {
  const marker = snapshot.marker;
  if (!marker) {
    return;
  }
  const mapPoint = clientPointToMapCoords(clientPoint.clientX, clientPoint.clientY);
  const normalized = mapPoint ? toNormalizedMapCoords(mapPoint) : null;
  if (!normalized) {
    revertMarkerPosition(snapshot);
    return;
  }
  applyMarkerCoords(marker, normalized);
  try {
    const updated = await updatePoiOnServer(snapshot.id, normalized, snapshot.type);
    if (updated) {
      applyMarkerCoords(marker, updated);
    }
  } catch (error) {
    console.error("Failed to move POI", error);
    revertMarkerPosition(snapshot);
    alert("Failed to move marker. Please try again.");
  }
}

async function commitMarkerDelete(snapshot) {
  const marker = snapshot.marker;
  if (!marker || !snapshot.id) {
    return;
  }
  try {
    await deletePoiOnServer(snapshot.id);
    removeMarkerElement(marker);
  } catch (error) {
    console.error("Failed to delete POI", error);
    alert("Failed to delete marker. Please try again.");
  }
}

function removeMarkerElement(marker) {
  if (!marker) {
    return;
  }
  const poiId = marker.dataset?.id;
  if (poiId) {
    const normalizedId = poiId.toLowerCase();
    renderedPoiIds.delete(normalizedId);
    if (visitedPoiIds.delete(normalizedId)) {
      persistVisitedState();
    }
  }
  marker.remove();
}

function startIconDrag(icon, event) {
  if (!isMapReady() || !editMode) {
    return;
  }
  const type = Number(icon.dataset.type);
  if (!Number.isFinite(type)) {
    return;
  }
  event.preventDefault();
  if (dragState) {
    endDrag();
  }
  try {
    icon.setPointerCapture(event.pointerId);
  } catch (error) {
    // Ignore pointer capture failures.
  }
  dragState = {
    mode: "create",
    pointerId: event.pointerId,
    type,
    sourceElement: icon,
    ghost: createDragGhost(icon.src, icon.title || icon.alt || "", getDragGhostSizePx()),
  };
  updateDragGhostPosition({ clientX: event.clientX, clientY: event.clientY });
  attachDragListeners();
}

let dragListenersBound = false;

function attachDragListeners() {
  if (dragListenersBound) {
    return;
  }
  window.addEventListener("pointermove", handleDragPointerMove, { passive: false });
  window.addEventListener("pointerup", handleDragPointerUp, { passive: false });
  window.addEventListener("pointercancel", handleDragPointerCancel, { passive: false });
  dragListenersBound = true;
}

function detachDragListeners() {
  if (!dragListenersBound) {
    return;
  }
  window.removeEventListener("pointermove", handleDragPointerMove);
  window.removeEventListener("pointerup", handleDragPointerUp);
  window.removeEventListener("pointercancel", handleDragPointerCancel);
  dragListenersBound = false;
}

function handleDragPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  event.preventDefault();
  dragState.lastPoint = { clientX: event.clientX, clientY: event.clientY };
  updateDragGhostPosition(dragState.lastPoint);
  const highlightTrash =
    Boolean(
      trashCan &&
      dragState.mode === "move" &&
      isPointInsideElement(trashCan, event.clientX, event.clientY)
    );
  setTrashActive(highlightTrash);
}

function handleDragPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  const snapshot = dragState;
  const dropPoint = { clientX: event.clientX, clientY: event.clientY };
  const dropOnMap = isPointInsideElement(mapViewport, dropPoint.clientX, dropPoint.clientY);
  const dropOnTrash = trashCan ? isPointInsideElement(trashCan, dropPoint.clientX, dropPoint.clientY) : false;
  endDrag();
  if (snapshot.mode === "create" && Number.isFinite(snapshot.type)) {
    if (!dropOnMap) {
      return;
    }
    commitToolbarDrop(snapshot, dropPoint);
    return;
  }
  if (snapshot.mode === "move" && snapshot.marker) {
    if (dropOnTrash) {
      commitMarkerDelete(snapshot);
      return;
    }
    if (dropOnMap) {
      commitMarkerMove(snapshot, dropPoint);
    } else {
      revertMarkerPosition(snapshot);
    }
  }
}

function handleDragPointerCancel(event) {
  if (dragState && event.pointerId === dragState.pointerId) {
    endDrag();
  }
}

function updateDragGhostPosition(point) {
  if (!dragState?.ghost || !point) {
    return;
  }
  dragState.ghost.style.left = `${point.clientX}px`;
  dragState.ghost.style.top = `${point.clientY}px`;
}

function createDragGhost(src, label = "", sizePxOverride = null) {
  const ghost = document.createElement("img");
  ghost.className = "drag-ghost";
  ghost.src = src;
  ghost.alt = label;
  const numericSize = sizePxOverride ?? getDragGhostSizePx();
  const sizePx = `${Math.round(numericSize)}px`;
  ghost.style.width = sizePx;
  ghost.style.height = sizePx;
  document.body.appendChild(ghost);
  return ghost;
}

function endDrag() {
  if (!dragState) {
    return;
  }
  try {
    dragState.sourceElement?.releasePointerCapture?.(dragState.pointerId);
  } catch (error) {
    // Ignore pointer capture release failures.
  }
  if (dragState.marker) {
    dragState.marker.style.opacity = dragState.originalMarkerOpacity ?? "";
  }
  if (dragState.ghost?.parentElement) {
    dragState.ghost.parentElement.removeChild(dragState.ghost);
  }
  setTrashActive(false);
  dragState = null;
  detachDragListeners();
}

function isPointInsideElement(element, clientX, clientY) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function clientPointToMapCoords(clientX, clientY) {
  if (!isMapReady()) {
    return null;
  }
  const rect = mapViewport.getBoundingClientRect();
  const offsetX = clientX - rect.left;
  const offsetY = clientY - rect.top;
  const mapX = (offsetX - state.translateX) / state.scale;
  const mapY = (offsetY - state.translateY) / state.scale;
  if (Number.isNaN(mapX) || Number.isNaN(mapY)) {
    return null;
  }
  return { mapX, mapY };
}

function toNormalizedMapCoords(point) {
  if (!point || !isMapReady()) {
    return null;
  }
  const withinBounds =
    point.mapX >= 0 &&
    point.mapX <= state.mapWidth &&
    point.mapY >= 0 &&
    point.mapY <= state.mapHeight;
  if (!withinBounds) {
    return null;
  }
  return {
    x: clamp(point.mapX / state.mapWidth, 0, 1),
    y: clamp(point.mapY / state.mapHeight, 0, 1),
  };
}

async function commitToolbarDrop(dragSnapshot, clientPoint) {
  const mapPoint = clientPointToMapCoords(clientPoint.clientX, clientPoint.clientY);
  const normalized = mapPoint ? toNormalizedMapCoords(mapPoint) : null;
  if (!normalized) {
    return;
  }
  const pendingPoi = {
    id: generateGuidHex(),
    type: dragSnapshot.type,
    x: normalized.x,
    y: normalized.y,
  };
  try {
    const savedPoi = await createPoiOnServer(pendingPoi);
    renderPoiMarker(savedPoi);
  } catch (error) {
    console.error("Failed to place POI", error);
    alert("Failed to place marker. Please try again.");
  }
}

async function createPoiOnServer(poi) {
  const payload = await postToApi({ action: "create", mapId: MAP_ID_HEX, poi }, { requireCode: true });
  return normalizePoiRecord(payload?.data, poi);
}

async function updatePoiOnServer(poiId, coords, type) {
  const payload = await postToApi({
    action: "update",
    mapId: MAP_ID_HEX,
    poi: { id: poiId, x: coords.x, y: coords.y },
  }, { requireCode: true });
  return normalizePoiRecord(payload?.data, {
    id: poiId,
    type,
    x: coords.x,
    y: coords.y,
  });
}

async function deletePoiOnServer(poiId) {
  const payload = await postToApi({ action: "delete", mapId: MAP_ID_HEX, poiId }, { requireCode: true });
  return payload?.data ?? null;
}

function normalizePoiRecord(record, fallback = null) {
  const base = fallback || {};
  const id = String(record?.id || base.id || "").toLowerCase();
  const type = Number(record?.type ?? base.type);
  const x = Number(record?.x ?? base.x);
  const y = Number(record?.y ?? base.y);
  if (!id || Number.isNaN(type) || Number.isNaN(x) || Number.isNaN(y)) {
    return fallback || null;
  }
  return { id, type, x, y };
}

function generateGuidHex() {
  const cryptoScope = globalThis.crypto;
  if (typeof cryptoScope?.randomUUID === "function") {
    return cryptoScope.randomUUID().replace(/-/g, "").toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoScope?.getRandomValues === "function") {
    cryptoScope.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isMapReady() {
  return Boolean(state.initialized && state.mapWidth && state.mapHeight);
}

function loadVisitedPoiIds() {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(VISITED_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((id) => String(id || "").toLowerCase())
      .filter((id) => Boolean(id));
  } catch (error) {
    console.warn("Failed to load visited markers", error);
    return [];
  }
}

function persistVisitedState() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const payload = JSON.stringify(Array.from(visitedPoiIds));
    localStorage.setItem(VISITED_STORAGE_KEY, payload);
  } catch (error) {
    console.warn("Failed to persist visited markers", error);
  }
}

function syncVisitedOpacityVariable() {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement?.style.setProperty("--visited-opacity", String(VISITED_OPACITY));
}