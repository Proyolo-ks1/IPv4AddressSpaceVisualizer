// General Elements
const image = document.getElementById('ipv4-image');
const tooltip = document.getElementById('tooltip');
const zoomStepSelect = document.getElementById('zoom-step-select');
const ipTargetConsoleTooltip = document.getElementById('ip-target-console-tooltip');
const ipRangeConsoleTooltip = document.getElementById('ip-range-console-tooltip');
const canvas = document.createElement('canvas');
const viewport = document.getElementById('image-viewport');
const minimap = document.getElementById('viewport-minimap');
const rightInfoPanel = document.getElementById('ip-info-side-panel');
const hilbertToggle = document.getElementById('hilbert-toggle');
const hilbertOrderSlider = document.getElementById('hilbert-order');
const hilbertOrderLabel = document.getElementById('hilbert-order-label');

const hilbertState = {
    enabled: false,
    order: 0
};

// Canvasses
const baseCanvas = document.getElementById('base-canvas');
const gridCanvas = document.getElementById('grid-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');

// Canvas Configuration
const baseCtx = baseCanvas.getContext('2d');
const gridCtx = gridCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');
baseCtx.imageSmoothingEnabled = true;
baseCtx.imageSmoothingQuality = 'high';
gridCtx.imageSmoothingEnabled = false;
overlayCtx.imageSmoothingEnabled = false;

minimap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});
viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});

// --- Configuration ---
const MAX_ZOOM = 256;          // how many zoom levels
const IMAGE_SIZE = 4096;     // image is 4096x4096 pixels (Hilbert blocks)

// --- State ---
const mapState = {
    viewPos: {x:0, y:0},    // center focus position
    zoomFactor: 1,          // zoomfactor
    zoomStep: 2,            // multiplicative factor per zoom
    hilbertOffset: 0,       // top-left Hilbert index of current view
};

// MARK: Helpers - Graphic

function drawCross(ctx, x, y, size = 6) {
    ctx.beginPath();
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y + size);
    ctx.moveTo(x + size, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.stroke();
}

// MARK: Helpers - Logic

// --- Hilbert curve: 2D grid (x,y) -> 1D index d ---
// n: grid size (must be power of 2, e.g. 2,4,8,...)
// x, y: integer coordinates in range [0, n-1]
// returns: Hilbert curve index in range [0, n*n - 1]
function xy2d(n, x, y) {
    let d = 0, s = n >> 1, rx, ry;

    while (s > 0) {
        // rx, ry determine which quadrant of the current square (size s) we are in
        rx = (x & s) ? 1 : 0;
        ry = (y & s) ? 1 : 0;

        // accumulate Hilbert distance contribution of this quadrant
        d += s * s * ((3 * rx) ^ ry);

        // rotate/flip coordinates into next sub-square
        [x, y] = rot(s, x, y, rx, ry);

        // move to next smaller scale
        s >>= 1;
    }

    return d;
}

// --- Hilbert curve: 1D index d -> 2D grid (x,y) ---
// n: grid size (same domain as xy2d, power of 2)
// d: Hilbert index in range [0, n*n - 1]
// returns: {x, y} grid coordinate in range [0, n-1]
function d2xy(n, d) {
    let x = 0, y = 0;
    let t = d;

    // reconstruct coordinate bit-by-bit per quadrant level
    for (let s = 1; s < n; s *= 2) {
        const rx = 1 & (t / 2);
        const ry = 1 & (t ^ rx);

        const res = rot(s, x, y, rx, ry);
        x = res[0];
        y = res[1];

        x += s * rx;
        y += s * ry;

        t /= 4;
    }

    return { x, y };
}

// --- Rotation helper for Hilbert transform ---
// n: current square size
// x, y: current coordinates in that square
// rx, ry: quadrant flags (0/1)
// returns: rotated (x,y) for correct Hilbert ordering continuity
function rot(n, x, y, rx, ry) {
    if (ry === 0) {
        if (rx === 1) {
            x = n - 1 - x;
            y = n - 1 - y;
        }
        [x, y] = [y, x];
    }
    return [x, y];
}

// --- Convert mouse event to coordinates relative to image ---
function getImageCoords(mouseEvent) {
    const rect = viewport.getBoundingClientRect();
    const mouseX = mouseEvent.clientX - rect.left;
    const mouseY = mouseEvent.clientY - rect.top;
    return { mouseX, mouseY };
}

// --- Update IP range tooltip ---
function updateIPRange(tileX, tileY, order) {
    const N = 2 ** order;

    const tileHilbertIndex = xy2d(N, tileX, tileY);

    // At lower grid orders, one visible tile covers many 4096x4096 pixels.
    // Each image pixel represents one /24 block, meaning 256 IP addresses.
    const pixelsPerTileSide = IMAGE_SIZE / N;
    const blocksPerTile = pixelsPerTileSide * pixelsPerTileSide;

    const startBlock = tileHilbertIndex * blocksPerTile;
    const endBlock = startBlock + blocksPerTile - 1;

    const startAddress = startBlock * 256;
    const endAddress = endBlock * 256 + 255;

    const [s1, s2, s3, s4] = addressToIP(startAddress);
    const [e1, e2, e3, e4] = addressToIP(endAddress);

    ipRangeConsoleTooltip.textContent =
        `Tile IP range: ${s1}.${s2}.${s3}.${s4} - ${e1}.${e2}.${e3}.${e4}`;
}

function addressToIP(address) {
    return [
        (address >>> 24) & 0xFF,
        (address >>> 16) & 0xFF,
        (address >>> 8) & 0xFF,
        address & 0xFF
    ];
}

// MARK: drawCensusMap

// Draw Census Map
const img = new Image();
img.src = 'assets/IPv4-Census-VisualizationOfTheIPv4AddressSpace-20061108-4096x4096.png';

img.onload = () => {
    // Initially fit fully in viewport
    updateCanvas()
};

function drawCensusMap() {
    console.log('drawCensusMap()');

    // Resize canvas to fill viewport
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    baseCanvas.width = viewportWidth;
    baseCanvas.height = viewportHeight;

    // Determine how much to scale the image
    const baseScale = Math.min(viewportWidth, viewportHeight) / IMAGE_SIZE; // shortestSidePixels per imagePixels
    const totalScale = baseScale * mapState.zoomFactor;

    // Compute image draw size
    const drawWidth = IMAGE_SIZE * totalScale;
    const drawHeight = IMAGE_SIZE * totalScale;

    // Center image in viewport
    const offsetX = (viewportWidth - drawWidth) / 2;
    const offsetY = (viewportHeight - drawHeight) / 2;

    // Clear canvas and fill black background
    baseCtx.fillStyle = '#000';
    baseCtx.fillRect(0,0,viewportWidth,viewportHeight);

    // Draw the scaled portion of the image
    if (totalScale < 1) {
        // high quality downscaling
        baseCtx.imageSmoothingEnabled = true;
        baseCtx.imageSmoothingQuality = 'high';

        drawScaledImage(
            baseCtx,
            img,
            0, 0, IMAGE_SIZE, IMAGE_SIZE,
            offsetX, offsetY, drawWidth, drawHeight
        );
    } else {
        // crisp zoom-in (no blur)
        baseCtx.imageSmoothingEnabled = false;

        baseCtx.drawImage(
            img,
            0, 0, IMAGE_SIZE, IMAGE_SIZE,
            offsetX, offsetY, drawWidth, drawHeight
        );
    }
}

function drawScaledImage(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
    let tempCanvas = document.createElement('canvas');
    let tempCtx = tempCanvas.getContext('2d');

    tempCanvas.width = sw;
    tempCanvas.height = sh;
    tempCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    while (sw * 0.5 > dw) {
        sw *= 0.5;
        sh *= 0.5;

        const newCanvas = document.createElement('canvas');
        const newCtx = newCanvas.getContext('2d');

        newCanvas.width = sw;
        newCanvas.height = sh;

        newCtx.drawImage(tempCanvas, 0, 0, sw, sh);

        tempCanvas = newCanvas;
    }

    ctx.drawImage(tempCanvas, 0, 0, sw, sh, dx, dy, dw, dh);
}

// MARK: drawGrid

// TEMP DEBUG
const infoDivGridSize = document.createElement('div');
infoDivGridSize.style.fontSize = '14px';
infoDivGridSize.style.marginTop = '10px';
infoDivGridSize.style.color = '#ccc';
infoDivGridSize.innerHTML = `== INFO GRID ==`
rightInfoPanel.appendChild(infoDivGridSize);

function drawGrid() {
    console.log('drawGrid()');

    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    
    // Determine how much to scale the grid
    const baseScale = Math.min(viewportWidth, viewportHeight) / IMAGE_SIZE; // shortestSidePixels per imagePixel
    const totalScale = baseScale * mapState.zoomFactor; // shortestSidePixels per imagePixel with zoom

    // Compute grid draw size
    const gridWidth = IMAGE_SIZE * totalScale;
    const gridHeight = IMAGE_SIZE * totalScale;

    // Center grid in viewport
    const offsetX = (viewportWidth - gridWidth) / 2;
    const offsetY = (viewportHeight - gridHeight) / 2;

    gridCtx.clearRect(0, 0, viewportWidth, viewportHeight);
    gridCtx.strokeStyle = 'rgba(255, 174, 0, 0.51)';
    gridCtx.lineWidth = 1;

    const combinedZoom = mapState.zoomFactor * mapState.zoomStep;
    const level = Math.floor(Math.log2(combinedZoom));
    const divisions = 2 ** level;
    const gridSize = (IMAGE_SIZE / divisions) * totalScale;
    infoDivGridSize.innerHTML = `== INFO GRID ==<br>
                                • baseScale: ${baseScale.toFixed(2)} (${Math.min(viewportWidth, viewportHeight)}px / ${IMAGE_SIZE}px)<br>
                                • logZoom: ${Math.log2(mapState.zoomFactor).toFixed(2)} -> 2^${Math.log2(mapState.zoomFactor).toFixed(2)} = ${mapState.zoomFactor.toFixed(2)}x (zoom)<br>
                                • logZoomfloor+1: ${Math.floor(Math.log2(mapState.zoomFactor))+1}<br>
                                • totalScale: ${totalScale.toFixed(2)} (${baseScale.toFixed(2)}x * ${mapState.zoomFactor.toFixed(2)}x)<br>
                                • gridSizeNoScale: ${(IMAGE_SIZE / (2**(1+Math.floor((Math.log2(mapState.zoomFactor) + 2)))))}<br>
                                • gridSizeRelIMG: ${IMAGE_SIZE / (IMAGE_SIZE / (2**(1+Math.floor((Math.log2(mapState.zoomFactor) + 2)))))}<br>
                                • imgDivisions: ${2**(1+Math.floor(Math.log2(mapState.zoomFactor) + Math.log2(mapState.zoomStep)-1))}<br>
                                • gridSize: ${gridSize.toFixed(2)}`;


    // Draw vertical lines
    for (let x = offsetX; x <= offsetX + gridWidth; x += gridSize) {
        const px = Math.round(x) + 0.5; // sharpness correction
        gridCtx.beginPath();
        gridCtx.moveTo(px, offsetY);
        gridCtx.lineTo(px, offsetY + gridHeight);
        gridCtx.stroke();
    }

    // Draw horizontal lines
    for (let y = offsetY; y <= offsetY + gridHeight; y += gridSize) {
        const py = Math.round(y) + 0.5; // sharpness correction
        gridCtx.beginPath();
        gridCtx.moveTo(offsetX, py);
        gridCtx.lineTo(offsetX + gridWidth, py);
        gridCtx.stroke();
    }
    
    drawHilbertOverlay();
}

// MARK: drawHilbertOverlay

function drawHilbertOverlay() {
    const ctx = gridCtx;
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;

    if (!hilbertState.enabled || hilbertState.order === 0) return;

    const baseScale = Math.min(viewportWidth, viewportHeight) / IMAGE_SIZE;
    const totalScale = baseScale * mapState.zoomFactor;

    const gridWidth = IMAGE_SIZE * totalScale;
    const gridHeight = IMAGE_SIZE * totalScale;

    const offsetX = (viewportWidth - gridWidth) / 2;
    const offsetY = (viewportHeight - gridHeight) / 2;

    const N = 2 ** hilbertState.order;

    const cellSize = (IMAGE_SIZE / N) * totalScale;

    const points = [];

    ctx.strokeStyle = 'rgb(255, 0, 0)';
    ctx.lineWidth = 5;
    ctx.beginPath();

    for (let i = 0; i < N * N; i++) {
        const { x, y } = d2xy(N, i);

        const px = offsetX + x * cellSize + cellSize / 2;
        const py = offsetY + y * cellSize + cellSize / 2;

        points.push({ px, py });

        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }

    ctx.stroke();

    const size = cellSize / 4;
    ctx.fillStyle = 'rgb(0, 255, 0)';

    // ---------- START (centered on point 0) ----------
    {
        const p0 = points[0];
        const p1 = points[1];

        const angle = Math.atan2(p1.py - p0.py, p1.px - p0.px);

        const cx = p0.px;
        const cy = p0.py;

        const tipX = cx + Math.cos(angle) * size * 0.6;
        const tipY = cy + Math.sin(angle) * size * 0.6;

        const baseX = cx - Math.cos(angle) * size * 0.4;
        const baseY = cy - Math.sin(angle) * size * 0.4;

        const halfW = size * 0.5;

        const leftX = baseX + Math.cos(angle + Math.PI / 2) * halfW;
        const leftY = baseY + Math.sin(angle + Math.PI / 2) * halfW;

        const rightX = baseX + Math.cos(angle - Math.PI / 2) * halfW;
        const rightY = baseY + Math.sin(angle - Math.PI / 2) * halfW;

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(leftX, leftY);
        ctx.lineTo(rightX, rightY);
        ctx.closePath();
        ctx.fill();
    }

    // ---------- END (centered on last point) ----------
    {
        const last = points.length - 1;

        const p0 = points[last - 1];
        const p1 = points[last];

        const angle = Math.atan2(p1.py - p0.py, p1.px - p0.px);

        const cx = p1.px;
        const cy = p1.py;

        const tipX = cx + Math.cos(angle) * size * 0.6;
        const tipY = cy + Math.sin(angle) * size * 0.6;

        const baseX = cx - Math.cos(angle) * size * 0.4;
        const baseY = cy - Math.sin(angle) * size * 0.4;

        const halfW = size * 0.5;

        const leftX = baseX + Math.cos(angle + Math.PI / 2) * halfW;
        const leftY = baseY + Math.sin(angle + Math.PI / 2) * halfW;

        const rightX = baseX + Math.cos(angle - Math.PI / 2) * halfW;
        const rightY = baseY + Math.sin(angle - Math.PI / 2) * halfW;

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(leftX, leftY);
        ctx.lineTo(rightX, rightY);
        ctx.closePath();
        ctx.fill();
    }
}

// MARK: drawTileAndPointer

let lastTile = {
    x: null,
    y: null,
    size: null,
    level: null
};

// TEMP DEBUG
const infoDivTile = document.createElement('div');
infoDivTile.style.fontSize = '14px';
infoDivTile.style.marginTop = '10px';
infoDivTile.style.color = '#ccc';
infoDivGridSize.innerHTML = `== INFO TILE ==`
rightInfoPanel.appendChild(infoDivTile);

function drawTileAndPointer(mouseX, mouseY) {
    console.log('drawTileAndPointer()');

    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    overlayCtx.clearRect(0, 0, viewportWidth, viewportHeight);

    // Draw Tile
    const baseScale = Math.min(viewportWidth, viewportHeight) / IMAGE_SIZE;
    const totalScale = baseScale * mapState.zoomFactor;

    const drawWidth = IMAGE_SIZE * totalScale;
    const drawHeight = IMAGE_SIZE * totalScale;

    const offsetX = (viewportWidth - drawWidth) / 2;
    const offsetY = (viewportHeight - drawHeight) / 2;

    // mouse → image space
    const imgX = (mouseX - offsetX) / totalScale;
    const imgY = (mouseY - offsetY) / totalScale;

    const insideImage =
    imgX >= 0 && imgY >= 0 &&
    imgX < IMAGE_SIZE && imgY < IMAGE_SIZE;

    if (insideImage) {
        const combinedZoom = mapState.zoomFactor * mapState.zoomStep;
        const level = Math.floor(Math.log2(combinedZoom));
        const divisions = 2 ** level;

        const cellSize = IMAGE_SIZE / divisions;

        const tileX = Math.floor(imgX / cellSize);
        const tileY = Math.floor(imgY / cellSize);

        const tileScreenX = offsetX + tileX * cellSize * totalScale;
        const tileScreenY = offsetY + tileY * cellSize * totalScale;
        const tileScreenSize = cellSize * totalScale;

        overlayCtx.fillStyle = 'rgba(200, 200, 200, 0.3)';
        overlayCtx.fillRect(
            tileScreenX,
            tileScreenY,
            tileScreenSize,
            tileScreenSize
        );

        overlayCtx.strokeStyle = 'red';
        overlayCtx.strokeRect(
            tileScreenX,
            tileScreenY,
            tileScreenSize,
            tileScreenSize
        );

        // Did Tile change? Update IP-Range
        const tileSize = cellSize;
        const tileChanged =
            tileX !== lastTile.x ||
            tileY !== lastTile.y ||
            tileSize !== lastTile.size ||
            level !== lastTile.level;
        if (tileChanged) {
            lastTile = {
                x: tileX,
                y: tileY,
                size: tileSize,
                level
            };

            updateIPRange(tileX, tileY, level);
        }
    }

    // Draw Crosshair
    overlayCtx.fillStyle = '#ff0000';
    overlayCtx.fillRect(mouseX-5, mouseY-1, 10, 3)
    overlayCtx.fillRect(mouseX-1, mouseY-5, 3, 10)

    
    infoDivTile.innerHTML = `== INFO TILE ==<br>
                            • drawHeight: ${drawHeight.toFixed(2)}<br>
                            • drawWidth: ${drawWidth.toFixed(2)}`
}

// MARK: EventListeners

// --- Mouse move handler ---
viewport.addEventListener('mousemove', (e) => {
    // console.log('mousemove:', e);
    const { mouseX, mouseY } = getImageCoords(e);
    drawTileAndPointer(mouseX, mouseY);
});

viewport.addEventListener('mouseleave', () => {
    console.log('mouseleave');
    tooltip.style.display = 'none';
    overlayCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    ipTargetConsoleTooltip.textContent = 'Target IP: Hover over the image';
    ipRangeConsoleTooltip.textContent = 'Tile IP range: Hover over the image';
});

// Create a zoom display element - TEMP DEBUG
const infoDivZoom = document.createElement('div');
infoDivZoom.style.fontSize = '14px';
infoDivZoom.style.marginTop = '10px';
infoDivZoom.style.color = '#ccc';
infoDivZoom.innerHTML = `== INFO ZOOM ==<br>
                            • Zoom: ${mapState.zoomFactor.toFixed(2)}x`;
rightInfoPanel.insertBefore(infoDivZoom, infoDivGridSize);

viewport.addEventListener('wheel', (e) => {
    e.preventDefault(); // prevent page scroll

    const zoomSpeed = 0.3 // how fast to zoom
    const zoomFactor = 1 + zoomSpeed
    //const zoomFactor = mapState.zoomStep; // if we would do like 2x, 4x etc 
    if (e.deltaY < 0) {
        // Scroll up → zoom in
        mapState.zoomFactor *= zoomFactor;
        mapState.zoomFactor = Math.min(mapState.zoomFactor, MAX_ZOOM); // Prevent zooming in past MAX_ZOOM
    } else {
        // Scroll down → zoom out
        mapState.zoomFactor /= zoomFactor;
        mapState.zoomFactor = Math.max(mapState.zoomFactor, 1); // Prevent zooming out past full view
    }
    
    infoDivZoom.innerHTML = `== INFO ZOOM ==<br>
                            • Zoom: ${mapState.zoomFactor.toFixed(2)}x`;
    drawCensusMap();
    drawGrid();
    drawTileAndPointer();
}, { passive: false }); // passive: false required to use preventDefault

// Zoomstep dropdown selection
zoomStepSelect.addEventListener('change', (e) => {
    mapState.zoomStep = parseInt(e.target.value, 10);
    console.log('Zoom step updated to:', mapState.zoomStep);
    drawGrid();
    drawHilbertOverlay();
});

// Hilbert Curve selection
hilbertToggle.addEventListener('change', () => {
    hilbertState.enabled = hilbertToggle.checked;
    drawGrid();
});

hilbertOrderSlider.addEventListener('input', () => {
    hilbertState.order = Number(hilbertOrderSlider.value);

    hilbertOrderLabel.textContent =
        hilbertState.order === 0 ? 'Off' : `Order ${hilbertState.order}`;
    drawGrid();
});

// Browser Window
function logCanvasAndViewport() {
    const cw = canvas.width;
    const ch = canvas.height;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;

    console.log(`Canvas: ${cw}x${ch}\nViewport: ${vw}x${vh}`);
}

function updateCanvas() {
    drawCensusMap();
    drawGrid()
    drawTileAndPointer()
}

function onViewportChange() {
    logCanvasAndViewport()

    // Resize canvas to fill viewport
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    baseCanvas.width = viewportWidth;
    baseCanvas.height = viewportHeight;
    gridCanvas.width = viewportWidth;
    gridCanvas.height = viewportHeight;
    overlayCanvas.width = viewportWidth;
    overlayCanvas.height = viewportHeight;

    updateCanvas()
}
window.addEventListener('resize', onViewportChange);

// Initial call once DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    onViewportChange();
    mapState.zoomStep = parseInt(zoomStepSelect.value, 10);

    // uncheck hilbert curve checkbox 
    hilbertToggle.checked = false;
    hilbertState.enabled = false;
});


