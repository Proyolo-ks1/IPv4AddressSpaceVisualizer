const image = document.getElementById('ipv4-image');
const tooltip = document.getElementById('tooltip');
const ipAddressEl = document.getElementById('ip-address');

// Convert (x, y) to Hilbert index
function xy2d(n, x, y) {
    let d = 0;
    let s = n >> 1;
    let rx, ry;
    while (s > 0) {
        rx = (x & s) > 0 ? 1 : 0;
        ry = (y & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        [x, y] = rot(s, x, y, rx, ry);
        s >>= 1;
    }
    return d;
}

// Rotate/flip quadrant
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

image.addEventListener('mousemove', (e) => {
    const rect = image.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Get pixel coordinates relative to original 4096x4096 image
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const pixelX = Math.floor(x * scaleX);
    const pixelY = Math.floor(y * scaleY);

    // Show tooltip
    tooltip.style.left = `${x + 10}px`;
    tooltip.style.top = `${y + 10}px`;
    tooltip.style.display = 'block';
    tooltip.textContent = `Pixel: (${pixelX}, ${pixelY})`;

    // Convert pixel to Hilbert index
    const hilbertIndex = xy2d(4096, pixelX, pixelY);

    // Each pixel = /24 block = 256 addresses
    const ipBase = hilbertIndex * 256;
    const ip1 = (ipBase >>> 24) & 0xFF;
    const ip2 = (ipBase >>> 16) & 0xFF;
    const ip3 = (ipBase >>> 8) & 0xFF;
    const ip4 = ipBase & 0xFF;

    const ipConsole = document.getElementById('ip-console');
    ipConsole.textContent = `IP: ${ip1}.${ip2}.${ip3}.${ip4}`;
});

image.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    ipConsole.textContent = 'Hover over the image';
});