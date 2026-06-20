const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';

/**
 * Sends a floor plan image to Claude and asks it to suggest room names/sub-headings.
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @returns {Promise<string[]>} suggested room names, in a sensible reading order
 */
async function suggestRooms(imageBuffer, mimeType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY env var. See .env.example for setup.');
  }

  const client = new Anthropic({ apiKey });
  const base64 = imageBuffer.toString('base64');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64 },
          },
          {
            type: 'text',
            text:
              'This is a residential/commercial floor plan. Identify every distinct room or ' +
              'space (e.g. "Living Room", "Master Bedroom", "Kitchen", "Bathroom 2", "Balcony"). ' +
              'Reply with ONLY a JSON array of strings, one per room, in reading order ' +
              '(left-to-right, top-to-bottom). No other text.',
          },
        ],
      },
    ],
  });

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Could not parse room suggestions from AI response');
  }

  const rooms = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(rooms)) {
    throw new Error('AI response was not a list of room names');
  }
  return rooms.filter((r) => typeof r === 'string' && r.trim().length > 0);
}

module.exports = { suggestRooms };
