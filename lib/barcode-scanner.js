'use strict';

/**
 * Barcode Scanner Module
 * Generates real scannable barcodes using bwip-js (CODE128 standard)
 * Falls back to SVG-based visual barcodes if bwip-js unavailable
 */

let bwip = null;

// Lazy-load bwip-js to avoid bloating bundle
try {
  bwip = require('bwip-js');
  console.log('[BARCODE] bwip-js loaded successfully (real barcode generation enabled)');
} catch (err) {
  console.log('[BARCODE] bwip-js not available, using fallback SVG visualization');
}

module.exports = function createBarcodeScanner() {

  /**
   * Generate real scannable barcode (CODE128)
   * Produces SVG that barcode scanners can read
   */
  const generateScannableBarcode = async (data, options = {}) => {
    const {
      format = 'code128',
      height = 50,
      margin = 5
    } = options;

    if (!bwip) {
      return generateFallbackSVGBarcode(data, { height, margin });
    }

    try {
      const svg = await bwip.toSVG({
        bcid: format,
        text: data,
        scale: 2,
        height,
        margin
      });

      return {
        type: 'real_barcode',
        format: 'CODE128',
        data,
        svg,
        scannable: true,
        generatedAt: new Date().toISOString()
      };
    } catch (err) {
      console.warn('[BARCODE] bwip-js generation failed, falling back:', err.message);
      return generateFallbackSVGBarcode(data, { height, margin });
    }
  };

  /**
   * Fallback: Generate visual-only SVG barcode
   * Not scannable, but visually represents the data
   */
  const generateFallbackSVGBarcode = (data, options = {}) => {
    const { height = 50, margin = 5 } = options;
    const barWidth = 3;
    const numBars = Math.min(data.length * 2, 80);
    const totalWidth = numBars * barWidth + margin * 2;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height + 40}" viewBox="0 0 ${totalWidth} ${height + 40}">`;
    svg += `<rect width="${totalWidth}" height="${height + 40}" fill="white"/>`;

    // Generate bar pattern (varies height for visual realism)
    for (let i = 0; i < numBars; i++) {
      const barHeight = height * (0.6 + 0.4 * Math.sin(i / numBars * Math.PI));
      const x = margin + i * barWidth;
      const y = (height - barHeight) / 2;
      svg += `<rect x="${x}" y="${y}" width="${barWidth - 1}" height="${barHeight}" fill="black"/>`;
    }

    // Add text label
    svg += `<text x="${totalWidth / 2}" y="${height + 25}" font-family="monospace" font-size="12" text-anchor="middle">${data}</text>`;
    svg += `</svg>`;

    return {
      type: 'fallback_barcode',
      format: 'SVG_Visual',
      data,
      svg,
      scannable: false,
      warning: 'Not scannable - visual representation only. Install bwip-js for real barcode generation.',
      generatedAt: new Date().toISOString()
    };
  };

  /**
   * Decode barcode data (placeholder for future barcode reader integration)
   * Would use QuaggaJS or similar for browser-based scanning
   */
  const decodeBarcode = (imageData) => {
    // TODO: Integrate QuaggaJS or similar for client-side barcode reading
    return {
      status: 'not_implemented',
      message: 'Client-side barcode reading requires QuaggaJS integration',
      hint: 'Use mobile app or server-side OCR for barcode extraction'
    };
  };

  /**
   * Validate barcode format
   */
  const validateBarcode = (barcode, format = 'CODE128') => {
    if (!barcode || barcode.length === 0) {
      return { valid: false, error: 'Barcode cannot be empty' };
    }

    if (format === 'CODE128') {
      // CODE128 can encode most printable ASCII
      const valid = /^[\x00-\x7F]+$/.test(barcode);
      return {
        valid,
        error: valid ? null : 'CODE128 requires ASCII-encodable characters',
        length: barcode.length
      };
    }

    return { valid: true, format };
  };

  /**
   * Integration point: Label printing with barcode
   */
  const generateShippingLabelWithBarcode = async (labelData) => {
    const {
      orderNumber,
      trackingNumber,
      cartonNumber,
      recipientName,
      address,
      postalCode
    } = labelData;

    // Generate barcode for tracking number
    const barcodeResult = await generateScannableBarcode(trackingNumber || orderNumber, {
      format: 'code128',
      height: 40,
      margin: 3
    });

    return {
      orderNumber,
      trackingNumber,
      cartonNumber,
      recipientName,
      address,
      postalCode,
      barcode: barcodeResult,
      barcodeEmbedded: barcodeResult.svg,
      scannable: barcodeResult.scannable,
      format: barcodeResult.format,
      htmlLabel: generateLabelHTML(labelData, barcodeResult.svg),
      timestamp: new Date().toISOString()
    };
  };

  /**
   * Generate HTML label with embedded barcode (for printing)
   */
  const generateLabelHTML = (labelData, barcodeSvg) => {
    const { orderNumber, trackingNumber, recipientName, address, postalCode } = labelData;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Shipping Label</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .label-box { border: 2px solid black; width: 200mm; height: 100mm; padding: 10mm; }
    .barcode { text-align: center; margin: 10px 0; }
    .header { font-weight: bold; font-size: 16px; margin-bottom: 10px; }
    .field { margin: 5px 0; }
    .field-label { font-weight: bold; font-size: 12px; }
    .field-value { font-size: 14px; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <div class="label-box">
    <div class="header">SHIPPING LABEL</div>

    <div class="barcode">${barcodeSvg}</div>

    <div class="field">
      <div class="field-label">Order #:</div>
      <div class="field-value">${orderNumber}</div>
    </div>

    <div class="field">
      <div class="field-label">Tracking #:</div>
      <div class="field-value">${trackingNumber}</div>
    </div>

    <div class="field">
      <div class="field-label">To:</div>
      <div class="field-value">${recipientName}</div>
    </div>

    <div class="field">
      <div class="field-value">${address}</div>
      <div class="field-value">${postalCode}</div>
    </div>
  </div>
</body>
</html>`;
  };

  return {
    generateScannableBarcode,
    generateFallbackSVGBarcode,
    decodeBarcode,
    validateBarcode,
    generateShippingLabelWithBarcode,
    generateLabelHTML,
    isRealBarcodeAvailable: !!bwip
  };
};
