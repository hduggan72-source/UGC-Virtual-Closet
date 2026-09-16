require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    providers: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai:    !!process.env.OPENAI_API_KEY,
      grok:      !!process.env.GROK_API_KEY,
      google:    !!process.env.GOOGLE_API_KEY,
    }
  });
});

// ─────────────────────────────────────────────
// AUTO-NAME + CATEGORIZE OUTFIT (Claude Haiku)
// ─────────────────────────────────────────────
app.post('/api/name-outfit', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: `You are a fashion stylist categorizing a closet image. Respond with ONLY valid JSON, no other text, in this exact format:
{"name": "Short Outfit Name", "category": "one-of-the-categories-below"}

Categories (pick the single best match):
- "full-look" — a complete outfit board with multiple pieces styled together (dress/jumpsuit + shoes + accessories, or full head-to-toe flat lay)
- "top" — a single top, blouse, shirt, sweater, bodysuit
- "bottom" — a single skirt, pants, shorts, jeans
- "dress" — a single dress or jumpsuit shown alone (not styled as a full board)
- "outerwear" — a jacket, coat, blazer, cardigan
- "footwear" — shoes, boots, heels, sneakers
- "hosiery" — tights, stockings, socks
- "jewelry" — earrings, necklaces, bracelets, rings
- "bag" — handbags, purses, clutches
- "accessory" — belts, scarves, hats, sunglasses, other accessories

The name should be 3-5 words, title case, no punctuation at the end.`,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Name and categorize this closet image.' }
        ]}]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude error' });
    const raw = data.content?.find(b => b.type === 'text')?.text?.trim() || '{}';
    let parsed;
    try {
      const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = { name: raw.slice(0, 60), category: 'full-look' };
    }
    res.json({ name: parsed.name || '', category: parsed.category || 'full-look' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ANALYZE AVATAR → DETAILED DESCRIPTOR (Claude Sonnet)
// ─────────────────────────────────────────────
app.post('/api/analyze-avatar', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 200,
        system: `You are an AI image prompt specialist. Analyze this person photo and write a precise physical descriptor for use in AI image generation prompts. Focus on: skin tone, hair color and style, eye color, face shape, height/body type, distinctive features. Write in natural language as a descriptor phrase, not a list. Be specific and detailed. Max 80 words. Output ONLY the descriptor, nothing else.`,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Describe this person in detail for AI image generation.' }
        ]}]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude error' });
    res.json({ descriptor: data.content?.find(b => b.type === 'text')?.text?.trim() || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ANALYZE COMBINED LOOK → PROMPT (multiple pieces → one outfit)
// ─────────────────────────────────────────────
app.post('/api/analyze-look', async (req, res) => {
  const { items, avatarDesc, avatarStyle, platform, mood, framing } = req.body;
  // items: [{ imageBase64, mediaType, category }]
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No items provided' });

  const moodMap = {
    editorial: 'editorial fashion photography, high-end magazine aesthetic, soft studio lighting',
    casual:    'candid lifestyle photography, golden hour, natural setting, effortless',
    luxury:    'luxury fashion campaign, aspirational, dramatic lighting, rich textures',
    playful:   'bright playful photography, vibrant colors, fun dynamic pose',
    moody:     'moody atmospheric, dramatic shadows, cinematic color grading',
    fresh:     'fresh natural light, clean background, soft and airy',
    streetwear:'urban street style, city backdrop, dynamic pose',
  };
  const platformMap = {
    Instagram:  'square 1:1, bold scroll-stopping composition',
    Pinterest:  'vertical portrait 2:3, aspirational lifestyle',
    TikTok:     'vertical 9:16, energetic dynamic pose',
    LinkedIn:   'professional polished, clean background',
    'Twitter/X':'high contrast, clear focal point',
  };

  const subject   = avatarDesc || 'a stylish woman';
  const styleNote = avatarStyle ? `. Render in ${avatarStyle} style` : '';
  const moodText  = moodMap[mood] || moodMap.editorial;
  const platText  = platformMap[platform] || platformMap.Instagram;

  // Build multimodal content: one image per item, each labeled with its category
  const content = [];
  items.forEach((item) => {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: item.mediaType || 'image/jpeg', data: item.imageBase64 }
    });
    content.push({ type: 'text', text: `↑ This is the ${item.category || 'item'} piece.` });
  });
  content.push({
    type: 'text',
    text: `You were just shown ${items.length} separate clothing/accessory pieces (each labeled by category above). Write a single AI image generation prompt showing a woman who looks exactly like this: ${subject}${styleNote}, wearing ALL of these pieces combined together as one cohesive outfit. Describe how the pieces work together (layering order, fit, styling). Shot framing: ${framing || '3/4 shot, head to mid-thigh'}. Mood: ${moodText}. Platform: ${platText}. Include specific details from each piece. End with: high resolution, professional fashion photography, 8k.`
  });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system: 'You are a professional fashion stylist and AI image prompt engineer. You combine multiple individual clothing pieces into one cohesive, realistic styled outfit description. Output ONLY the prompt text. Max 180 words.',
        messages: [{ role: 'user', content }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude error' });
    res.json({ prompt: data.content?.find(b => b.type === 'text')?.text?.trim() || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ANALYZE OUTFIT → PROMPT (Claude Sonnet)
// ─────────────────────────────────────────────
app.post('/api/analyze-outfit', async (req, res) => {
  const { imageBase64, mediaType, avatarDesc, avatarStyle, platform, mood, framing } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY' });

  const moodMap = {
    editorial: 'editorial fashion photography, high-end magazine aesthetic, soft studio lighting',
    casual:    'candid lifestyle photography, golden hour, natural setting, effortless',
    luxury:    'luxury fashion campaign, aspirational, dramatic lighting, rich textures',
    playful:   'bright playful photography, vibrant colors, fun dynamic pose',
    moody:     'moody atmospheric, dramatic shadows, cinematic color grading',
    fresh:     'fresh natural light, clean background, soft and airy',
    streetwear:'urban street style, city backdrop, dynamic pose',
  };
  const platformMap = {
    Instagram:  'square 1:1, bold scroll-stopping composition',
    Pinterest:  'vertical portrait 2:3, aspirational lifestyle',
    TikTok:     'vertical 9:16, energetic dynamic pose',
    LinkedIn:   'professional polished, clean background',
    'Twitter/X':'high contrast, clear focal point',
  };

  const subject   = avatarDesc || 'a stylish woman';
  const styleNote = avatarStyle ? `. Render in ${avatarStyle} style` : '';
  const moodText  = moodMap[mood] || moodMap.editorial;
  const platText  = platformMap[platform] || platformMap.Instagram;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 350,
        system: 'You are a professional fashion stylist and AI image prompt engineer. Analyze outfit images and write precise vivid image generation prompts. Output ONLY the prompt text. Max 150 words.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          {
            type: 'text',
            text: `Write an AI image generation prompt showing a woman who looks exactly like this: ${subject}${styleNote}, wearing this exact outfit. Shot framing: ${framing || '3/4 shot, head to mid-thigh'}. Mood: ${moodText}. Platform: ${platText}. Include specific outfit details visible in the image. The subject's physical appearance must match the descriptor closely. End with: high resolution, professional fashion photography, 8k.`
          }
        ]}]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude error' });
    res.json({ prompt: data.content?.find(b => b.type === 'text')?.text?.trim() || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// OPENAI GPT-IMAGE-2.5 FLARE (fast, high-quality; supports up to 16 reference images)
// Falls back to /v1/images/generations for text-only prompts
// ─────────────────────────────────────────────
app.post('/api/generate/openai', async (req, res) => {
  const { prompt, avatarBase64, avatarMediaType, outfitBase64, outfitMediaType, itemImages, size = '1024x1024' } = req.body;
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'No OPENAI_API_KEY' });

  const MODEL = 'gpt-image-2.5-flare-2026-09-08'; // pinned dated snapshot

  try {
    const hasSingleOutfit = !!outfitBase64;
    const hasMultipleItems = Array.isArray(itemImages) && itemImages.length > 0;
    const hasImages = avatarBase64 || hasSingleOutfit || hasMultipleItems;

    if (hasImages) {
      // Build multipart form manually — no external package needed
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const CRLF = '\r\n';
      const parts = [];

      const addField = (name, value) => {
        parts.push(Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`
        ));
      };
      const addFile = (name, filename, mime, b64data) => {
        const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`;
        parts.push(Buffer.from(header));
        parts.push(Buffer.from(b64data, 'base64'));
        parts.push(Buffer.from(CRLF));
      };

      addField('model', MODEL);
      addField('prompt', prompt);
      addField('n', '1');
      addField('size', size);
      addField('quality', 'high');

      if (avatarBase64) addFile('image[]', 'avatar.jpg', avatarMediaType || 'image/jpeg', avatarBase64);

      if (hasMultipleItems) {
        // Mix & match: send each individual piece as its own reference image
        itemImages.forEach((item, i) => {
          addFile('image[]', `item${i}.jpg`, item.mediaType || 'image/jpeg', item.imageBase64);
        });
      } else if (hasSingleOutfit) {
        addFile('image[]', 'outfit.jpg', outfitMediaType || 'image/jpeg', outfitBase64);
      }

      parts.push(Buffer.from(`--${boundary}--${CRLF}`));
      const body = Buffer.concat(parts);

      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        body,
      });

      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'OpenAI error' });
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) return res.status(500).json({ error: 'No image returned from OpenAI' });
      return res.json({ imageBase64: b64 });

    } else {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, prompt, n: 1, size, quality: 'high' })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'OpenAI error' });
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) return res.status(500).json({ error: 'No image returned from OpenAI' });
      return res.json({ imageBase64: b64 });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// xAI GROK — grok-imagine-image-quality (upgraded tier)
// ─────────────────────────────────────────────
app.post('/api/generate/grok', async (req, res) => {
  // xAI does NOT accept "size" — it rejects the request with a generic 400.
  // Use aspect_ratio (matches our existing 1:1 / 3:4 / 9:16 / 4:3 / 16:9 labels
  // directly — all five are natively supported) and resolution instead.
  const { prompt, aspectRatio = '1:1' } = req.body;
  if (!process.env.GROK_API_KEY) return res.status(503).json({ error: 'No GROK_API_KEY' });
  try {
    const r = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image-quality',
        prompt,
        n: 1,
        aspect_ratio: aspectRatio,
        resolution: '2k',
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Grok error' });
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: 'No image URL from Grok' });
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    res.json({ imageBase64: Buffer.from(buffer).toString('base64') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// GOOGLE GEMINI 2.5 FLASH IMAGE ("Nano Banana")
// Replaces deprecated Imagen — supports multi-image fusion (avatar + outfit)
// Key goes in x-goog-api-key HEADER, not ?key= query param
// ─────────────────────────────────────────────
app.post('/api/generate/google', async (req, res) => {
  const { prompt, avatarBase64, avatarMediaType, outfitBase64, outfitMediaType, itemImages, aspectRatio = '1:1' } = req.body;
  if (!process.env.GOOGLE_API_KEY) return res.status(503).json({ error: 'No GOOGLE_API_KEY' });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`;

    const parts = [{ text: prompt }];
    if (avatarBase64) {
      parts.push({ inlineData: { mimeType: avatarMediaType || 'image/jpeg', data: avatarBase64 } });
    }
    if (Array.isArray(itemImages) && itemImages.length > 0) {
      // Mix & match: add each individual piece as its own reference image
      itemImages.forEach((item) => {
        parts.push({ inlineData: { mimeType: item.mediaType || 'image/jpeg', data: item.imageBase64 } });
      });
    } else if (outfitBase64) {
      parts.push({ inlineData: { mimeType: outfitMediaType || 'image/jpeg', data: outfitBase64 } });
    }

    // Key goes in the x-goog-api-key header, not the ?key= query param.
    // New Google AI Studio keys (AQ. prefix) are rejected by the query-param
    // path with a misleading "Expected OAuth 2 access token" error.
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GOOGLE_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio },
        }
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Google Gemini error' });

    const imgPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    const b64 = imgPart?.inlineData?.data;
    if (!b64) return res.status(500).json({ error: 'No image returned from Gemini' });

    res.json({ imageBase64: b64 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => console.log(`Virtual Closet running on port ${PORT}`));
