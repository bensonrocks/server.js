'use strict';

/**
 * OCR Label Extraction Module
 * Extracts tracking numbers, addresses, and order info from shipping labels
 * Supports multiple OCR backends (placeholder for production integration)
 */

let tesseractAvailable = false;

// Try to load Tesseract (optional, lightweight JS implementation)
try {
  // Note: Full Tesseract would require: npm install tesseract.js
  // For now, using pattern-based extraction (works for most labels)
  tesseractAvailable = false;
  console.log('[OCR] Pattern-based label extraction ready (Tesseract.js recommended for production)');
} catch (err) {
  console.log('[OCR] Tesseract.js not available, using pattern matching');
}

module.exports = function createOCRLabels() {

  /**
   * Pattern-based tracking number detection
   * Priority order: most specific to most permissive
   */
  const extractTrackingNumber = (text) => {
    if (!text) return null;

    const patterns = [
      { regex: /\b(TXSGD\d{8,})\b/i, source: 'TRACX_LAZADA', confidence: 0.95 },
      { regex: /\b(SGDEX\d{8,})\b/i, source: 'SGDEX_REGIONAL', confidence: 0.92 },
      { regex: /\b(SG\d{9}SG)\b/i, source: 'POSTAL_FORMAT', confidence: 0.88 },
      { regex: /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i, source: 'INTL_STANDARD', confidence: 0.85 },
      { regex: /\b([A-Z]{2,4}\d{10,18})\b/, source: 'GENERIC', confidence: 0.70 }
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        return {
          trackingNumber: match[1],
          source: pattern.source,
          confidence: pattern.confidence,
          match: match[0]
        };
      }
    }

    return null;
  };

  /**
   * Extract order/reference numbers
   */
  const extractOrderNumber = (text) => {
    if (!text) return null;

    const patterns = [
      { regex: /Order\s*#?\s*[:=]?\s*([A-Z0-9\-]{8,20})/i, source: 'LABEL_PREFIX', confidence: 0.95 },
      { regex: /\bPO\s*#?\s*[:=]?\s*([A-Z0-9\-]{6,})/i, source: 'PO_PREFIX', confidence: 0.90 },
      { regex: /Invoice\s*#?\s*[:=]?\s*([0-9]{6,})/i, source: 'INVOICE_PREFIX', confidence: 0.90 },
      { regex: /^([A-Z0-9]{8,})$/m, source: 'STANDALONE', confidence: 0.60 }
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        return {
          orderNumber: match[1],
          source: pattern.source,
          confidence: pattern.confidence
        };
      }
    }

    return null;
  };

  /**
   * Extract recipient name
   */
  const extractRecipientName = (text) => {
    if (!text) return null;

    const patterns = [
      { regex: /To:\s*([A-Za-z\s\.]+)/i, source: 'TO_PREFIX', confidence: 0.95 },
      { regex: /Ship\s+To:\s*([A-Za-z\s\.]+)/i, source: 'SHIP_TO', confidence: 0.93 },
      { regex: /Recipient:\s*([A-Za-z\s\.]+)/i, source: 'RECIPIENT_PREFIX', confidence: 0.90 }
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        return {
          recipientName: match[1].trim(),
          source: pattern.source,
          confidence: pattern.confidence
        };
      }
    }

    return null;
  };

  /**
   * Extract address components
   */
  const extractAddress = (text) => {
    if (!text) return null;

    // Extract lines after "To:" or "Ship To:"
    const addressMatch = text.match(/(?:To:|Ship\s+To:)\s*([^\n]+)\n([^\n]*)\n([^\n]*)/i);

    if (addressMatch) {
      return {
        street: addressMatch[1].trim(),
        city: addressMatch[2].trim(),
        state: addressMatch[3].trim(),
        source: 'STRUCTURED_LINES',
        confidence: 0.85
      };
    }

    return null;
  };

  /**
   * Extract postal/ZIP code
   */
  const extractPostalCode = (text) => {
    if (!text) return null;

    const patterns = [
      { regex: /(?:S|SG)?[\s-]?(\d{6})(?:\s|$|,)/i, source: 'SINGAPORE_6DIGIT', confidence: 0.95 },
      { regex: /ZIP:\s*(\d{5,6})/i, source: 'ZIP_PREFIX', confidence: 0.90 },
      { regex: /Postal:\s*(\d{5,6})/i, source: 'POSTAL_PREFIX', confidence: 0.90 },
      { regex: /\b(\d{5,6})\b(?=\s*$|$)/m, source: 'STANDALONE_DIGITS', confidence: 0.70 }
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        return {
          postalCode: match[1],
          source: pattern.source,
          confidence: pattern.confidence
        };
      }
    }

    return null;
  };

  /**
   * Extract weight/dimensions (optional)
   */
  const extractDimensions = (text) => {
    if (!text) return null;

    const patterns = [
      { regex: /Weight:\s*([\d.]+)\s*(kg|g|lbs)/i, key: 'weight', confidence: 0.90 },
      { regex: /Dimensions:\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i, key: 'dimensions', confidence: 0.85 }
    ];

    const result = {};

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        result[pattern.key] = {
          value: match[1],
          source: pattern.key,
          confidence: pattern.confidence,
          fullMatch: match[0]
        };
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  };

  /**
   * Master extraction function
   * Parses label text and returns all extracted fields
   */
  const extractLabelFields = (labelText) => {
    if (!labelText || typeof labelText !== 'string') {
      return {
        status: 'failed',
        error: 'Invalid input',
        extracted: {}
      };
    }

    const tracking = extractTrackingNumber(labelText);
    const order = extractOrderNumber(labelText);
    const recipient = extractRecipientName(labelText);
    const address = extractAddress(labelText);
    const postal = extractPostalCode(labelText);
    const dimensions = extractDimensions(labelText);

    // Calculate overall confidence
    const confidenceScores = [
      tracking?.confidence || 0,
      order?.confidence || 0,
      postal?.confidence || 0,
      recipient?.confidence || 0
    ];
    const overallConfidence = Math.round((confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length) * 100);

    return {
      status: 'success',
      extracted: {
        trackingNumber: tracking,
        orderNumber: order,
        recipientName: recipient,
        address,
        postalCode: postal,
        dimensions
      },
      overallConfidence,
      needsManualReview: overallConfidence < 75,
      extractedAt: new Date().toISOString()
    };
  };

  /**
   * Integration point: Process uploaded label image/PDF
   * DEPLOYMENT GUIDANCE:
   *
   * For production, use one of these OCR services:
   *
   * 1. GOOGLE CLOUD VISION (Recommended for accuracy):
   *    - npm install @google-cloud/vision
   *    - Set GOOGLE_APPLICATION_CREDENTIALS env var
   *    - Cost: ~$1.50 per 1000 requests
   *    - Supports: Documents, handwriting, text detection
   *
   * 2. AWS TEXTRACT (Good for forms/structured data):
   *    - npm install @aws-sdk/client-textract
   *    - Configure AWS credentials
   *    - Cost: $0.50-$3.00 per document
   *    - Supports: Forms, tables, single-page extraction
   *
   * 3. AZURE COMPUTER VISION (Alternative):
   *    - npm install @azure/cognitiveservices-vision-computervision
   *    - Set Azure API key
   *    - Cost: ~$1.00 per 1000 requests
   *
   * 4. TESSERACT.JS (Open-source, local):
   *    - npm install tesseract.js
   *    - Zero cost, runs in Node.js
   *    - Speed: ~30-60ms per page
   *    - Accuracy: 85-95% depending on image quality
   *
   * For now, this module uses pattern-matching as fallback.
   * Add your OCR backend here when ready to deploy.
   */
  const processLabelImage = async (imagePath) => {
    // TODO: Implement actual OCR backend integration
    // Example structure:
    /*
    const vision = require('@google-cloud/vision');
    const client = new vision.ImageAnnotatorClient();
    const result = await client.textDetection({ image: { source: { filename: imagePath } } });
    const extractedText = result[0].fullTextAnnotation.text;
    return extractLabelFields(extractedText);
    */

    return {
      status: 'not_implemented',
      message: 'Image OCR requires backend integration',
      guidance: 'Use Google Vision, AWS Textract, or Tesseract.js for production',
      fallback: 'Pattern-based extraction available for structured text input'
    };
  };

  /**
   * Confidence scoring utility
   * Flags fields that need manual review
   */
  const validateExtraction = (extracted) => {
    const issues = [];

    if (!extracted.trackingNumber) {
      issues.push({
        field: 'trackingNumber',
        severity: 'critical',
        message: 'Tracking number not detected'
      });
    } else if (extracted.trackingNumber.confidence < 0.75) {
      issues.push({
        field: 'trackingNumber',
        severity: 'warning',
        confidence: extracted.trackingNumber.confidence,
        message: 'Tracking number confidence below 75%'
      });
    }

    if (!extracted.recipientName) {
      issues.push({
        field: 'recipientName',
        severity: 'high',
        message: 'Recipient name not detected'
      });
    }

    if (!extracted.postalCode) {
      issues.push({
        field: 'postalCode',
        severity: 'high',
        message: 'Postal code not detected'
      });
    } else if (extracted.postalCode.postalCode.length !== 6) {
      issues.push({
        field: 'postalCode',
        severity: 'warning',
        message: 'Postal code format incorrect (expected 6 digits for Singapore)'
      });
    }

    return {
      valid: issues.length === 0,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      issues,
      needsManualReview: issues.length > 0
    };
  };

  return {
    extractTrackingNumber,
    extractOrderNumber,
    extractRecipientName,
    extractAddress,
    extractPostalCode,
    extractDimensions,
    extractLabelFields,
    processLabelImage,
    validateExtraction,
    ocuEngineAvailable: tesseractAvailable
  };
};
