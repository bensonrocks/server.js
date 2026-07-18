'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function analyzeProductImage(imageBase64, mediaType = 'image/jpeg') {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const prompt = `You are an expert luxury brand marketing strategist for "Louve Luxe", a high-end fashion and lifestyle brand. Analyze this product image and provide:

1. **Product Analysis**: Describe what you see in detail - materials, style, colors, quality indicators, and luxury elements.

2. **Marketing Comments**: Provide 3-5 compelling marketing insights about this product's unique selling points and appeal.

3. **Instagram Strategy**: Create a comprehensive marketing plan for Instagram including:
   - Best posting time and frequency
   - Suggested hashtags (20-30 relevant ones)
   - Caption styles (luxury, aspirational, story-telling)
   - Content angles (styling tips, lifestyle, behind-the-scenes, craftsmanship)
   - Engagement tactics (questions to ask, calls-to-action)
   - Suggested carousel/reel ideas

4. **Target Audience**: Define the ideal Instagram audience for this product.

5. **Competitive Edge**: What makes this product stand out on Instagram compared to competitors?

Format your response as a structured JSON object with these keys: productAnalysis, marketingComments, instagramStrategy, targetAudience, competitiveEdge.`;

  const message = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

  // Extract JSON from the response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // If no JSON found, return raw response structured
    return {
      rawAnalysis: responseText,
      productAnalysis: '',
      marketingComments: [],
      instagramStrategy: {
        bestPostingTime: 'Peak engagement times vary',
        hashtags: [],
        captionStyles: [],
        contentAngles: [],
        engagementTactics: [],
        carouselReels: [],
      },
      targetAudience: '',
      competitiveEdge: '',
    };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      rawAnalysis: responseText,
      productAnalysis: '',
      marketingComments: [],
      instagramStrategy: {
        bestPostingTime: 'Peak engagement times vary',
        hashtags: [],
        captionStyles: [],
        contentAngles: [],
        engagementTactics: [],
        carouselReels: [],
      },
      targetAudience: '',
      competitiveEdge: '',
    };
  }
}

module.exports = {
  analyzeProductImage,
};
