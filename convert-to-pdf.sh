#!/bin/bash

# Convert HTML documentation to PDF for Shopee submission
# Requires: wkhtmltopdf or similar tool

echo "📄 Converting Shopee Integration Documentation to PDF..."

# Option 1: Using wkhtmltopdf (if installed)
if command -v wkhtmltopdf &> /dev/null; then
    wkhtmltopdf --page-size A4 --margin-top 0 --margin-bottom 0 \
        SHOPEE_INTEGRATION.html SHOPEE_INTEGRATION.pdf
    echo "✅ PDF created: SHOPEE_INTEGRATION.pdf"
    exit 0
fi

# Option 2: Using chromium/chrome
if command -v chromium &> /dev/null || command -v google-chrome &> /dev/null; then
    BROWSER=$(command -v chromium || command -v google-chrome)
    "$BROWSER" --headless --disable-gpu --print-to-pdf=SHOPEE_INTEGRATION.pdf \
        "file://$(pwd)/SHOPEE_INTEGRATION.html"
    echo "✅ PDF created: SHOPEE_INTEGRATION.pdf"
    exit 0
fi

# Option 3: Using pandoc
if command -v pandoc &> /dev/null; then
    pandoc SHOPEE_INTEGRATION.md -o SHOPEE_INTEGRATION.pdf \
        -f markdown -t pdf --pdf-engine=xelatex
    echo "✅ PDF created: SHOPEE_INTEGRATION.pdf"
    exit 0
fi

echo "❌ No PDF converter found."
echo "   Install one of: wkhtmltopdf, chromium, or pandoc"
echo ""
echo "   Alternative: Print SHOPEE_INTEGRATION.html to PDF from your browser"
