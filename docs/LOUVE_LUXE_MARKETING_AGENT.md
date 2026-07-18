# Louve Luxe - Automated Marketing Agent

## Overview

The Louve Luxe Automated Marketing Agent is an AI-powered tool that analyzes product images and generates comprehensive Instagram marketing strategies. Using Claude's vision capabilities, it provides instant marketing insights, product analysis, and Instagram-specific recommendations.

## Features

### 1. **Intelligent Product Analysis**
- Analyzes visual elements (materials, colors, quality indicators)
- Identifies luxury characteristics and unique selling points
- Provides detailed product descriptions

### 2. **Marketing Comments**
- Generates 3-5 compelling marketing insights
- Highlights unique selling points
- Creates aspirational appeal messaging

### 3. **Instagram Strategy**
- Best posting times and frequency recommendations
- 20-30 relevant hashtag suggestions
- Multiple caption style options (luxury, aspirational, storytelling)
- Content angles (styling tips, lifestyle, behind-the-scenes, craftsmanship)
- Engagement tactics with specific calls-to-action
- Carousel and Reel content ideas

### 4. **Audience Insights**
- Target audience definition
- Competitive positioning analysis
- Differentiation strategies

## API Endpoints

### POST `/api/louve-luxe/analyze-image`

Upload an image file and receive marketing analysis.

**Request:**
```bash
curl -X POST http://localhost:3000/api/louve-luxe/analyze-image \
  -F "image=@product.jpg"
```

**Response:**
```json
{
  "ok": true,
  "analysis": {
    "productAnalysis": "Detailed product description...",
    "marketingComments": ["Comment 1", "Comment 2", ...],
    "targetAudience": "Target audience description...",
    "competitiveEdge": "What makes this product unique...",
    "instagramStrategy": {
      "bestPostingTime": "Peak engagement times...",
      "hashtags": ["#luxury", "#fashion", ...],
      "captionStyles": ["Style 1", "Style 2", ...],
      "contentAngles": ["Angle 1", "Angle 2", ...],
      "engagementTactics": ["Tactic 1", "Tactic 2", ...],
      "carouselReels": ["Idea 1", "Idea 2", ...]
    }
  }
}
```

### POST `/api/louve-luxe/analyze-base64`

Analyze a product image provided as base64-encoded data.

**Request:**
```json
{
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "mediaType": "image/jpeg"
}
```

**Response:** Same as above

## Web Interface

Access the interactive marketing agent at: `http://localhost:3000/louve-luxe`

### Features:
- **Drag & Drop Upload**: Simply drag an image to the upload zone
- **Real-time Preview**: See the image before analysis
- **Live Results**: Get instant marketing insights
- **Organized Layout**: Results displayed in an easy-to-read format
- **Hashtag Suggestions**: Copy-ready hashtag recommendations
- **Mobile Responsive**: Works on desktop, tablet, and mobile

## Configuration

### Required Environment Variables

Set these in your `.env` file or deployment environment:

```bash
# Anthropic API Key (required for marketing agent)
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Server configuration
PORT=3000
NODE_ENV=production
```

## Usage Examples

### Example 1: Using the Web Interface
1. Navigate to `http://localhost:3000/louve-luxe`
2. Upload a product image
3. Click "Analyze Product"
4. Review comprehensive marketing insights
5. Copy hashtags and strategies for Instagram

### Example 2: Using the API with JavaScript
```javascript
const formData = new FormData();
formData.append('image', imageFile);

const response = await fetch('/api/louve-luxe/analyze-image', {
  method: 'POST',
  body: formData,
});

const data = await response.json();
console.log(data.analysis);
```

### Example 3: Using cURL
```bash
curl -X POST http://localhost:3000/api/louve-luxe/analyze-image \
  -F "image=@luxury_handbag.jpg" \
  | jq '.analysis.instagramStrategy.hashtags'
```

## Technical Details

### Architecture
- **Backend**: Express.js with Multer for file uploads
- **AI Engine**: Claude 3.5 Sonnet with vision capabilities
- **Storage**: In-memory processing (no persistent storage)
- **File Size**: Max 10MB per image

### Image Format Support
- JPEG (`.jpg`, `.jpeg`)
- PNG (`.png`)
- GIF (`.gif`)
- WebP (`.webp`)

### Processing
- Real-time analysis via Claude API
- Structured JSON response
- Fast processing (typically 5-10 seconds)

## Response Structure

```javascript
{
  // Product visual analysis
  productAnalysis: string,
  
  // Marketing insights (array of strings)
  marketingComments: [string],
  
  // Target audience description
  targetAudience: string,
  
  // Competitive positioning
  competitiveEdge: string,
  
  // Instagram-specific strategy
  instagramStrategy: {
    bestPostingTime: string,
    hashtags: [string],
    captionStyles: [string],
    contentAngles: [string],
    engagementTactics: [string],
    carouselReels: [string]
  }
}
```

## Best Practices

### For Best Results:
1. **Image Quality**: Use high-quality, well-lit product photos
2. **Clear View**: Ensure the product is clearly visible and centered
3. **Context**: Include lifestyle elements if relevant (styling, usage)
4. **Multiple Angles**: Analyze different product angles separately
5. **Consistent Style**: Maintain consistent visual identity in uploads

### Marketing Tips:
1. **Use Generated Hashtags**: Mix provided hashtags with trending ones
2. **Test Caption Styles**: Try different styles to see which resonates
3. **Content Rotation**: Alternate between different content angles
4. **Timing**: Post during recommended peak engagement times
5. **Engagement**: Implement suggested engagement tactics

## Error Handling

### Common Errors:

**401 - Missing/Invalid API Key**
```json
{
  "ok": false,
  "error": "ANTHROPIC_API_KEY not configured"
}
```

**400 - No Image Provided**
```json
{
  "ok": false,
  "error": "No image file provided"
}
```

**413 - File Too Large**
```json
{
  "ok": false,
  "error": "File size exceeds 10MB limit"
}
```

**415 - Invalid File Type**
```json
{
  "ok": false,
  "error": "Only image files are allowed"
}
```

## Limitations

- Maximum file size: 10MB
- Processing time: 5-10 seconds per image
- Requires active internet connection for API calls
- API rate limits apply based on Anthropic's pricing

## Deployment

### Railway/Heroku
1. Add `ANTHROPIC_API_KEY` to environment variables
2. Deploy as normal
3. Access at `https://your-domain.com/louve-luxe`

### Docker
Include in `docker-compose.yml`:
```yaml
environment:
  - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

### Local Development
```bash
# Install dependencies
npm install

# Set environment variable
export ANTHROPIC_API_KEY=sk-ant-...

# Start server
npm run dev

# Visit http://localhost:3000/louve-luxe
```

## Troubleshooting

### Agent not responding
- Check that `ANTHROPIC_API_KEY` is set correctly
- Verify internet connection
- Check API rate limits

### Image not processing
- Ensure file is a valid image format
- Reduce file size if > 5MB
- Check image permissions

### Missing analysis fields
- Raw analysis text is always returned
- Try re-uploading with a clearer image
- Check server logs for detailed errors

## Future Enhancements

- Batch image processing
- Historical analysis tracking
- A/B testing suggestions
- Competitor analysis
- Performance metrics integration
- Custom brand guidelines
- Multi-language support

## Support

For issues or feature requests, check the server logs and API responses for detailed error information.

---

**Version:** 1.0.0  
**Last Updated:** 2024  
**API Model:** Claude 3.5 Sonnet
