require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
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

// AUTO-NAME OUTFIT
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
        max_tokens: 60,
        system: 'You are a fashion stylist. Respond with ONLY a short outfit name, 3-5 words, title case. Examples: "Ivory Tweed Mini Dress", "Red Power Blouse Combo". No punctuation. No explanation.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Name this outfit.' }
        ]}]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude error' });
    res.json({ name: data.content?.find(b => b.type === 'text')?.text?.trim() || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ANALYZE AVATAR → DETAILED DESCRIPTOR
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

// ANALYZE OUTFIT → PROMPT
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
    Instagram: 'square 1:1, bold scroll-stopping composition',
    Pinterest: 'vertical portrait 2:3, aspirational lifestyle',
    TikTok:    'vertical 9:16, energetic dynamic pose',
    LinkedIn:  'professional polished, clean background',
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
          { type: 'text', text: `Write an AI image generation prompt showing a woman who looks exactly like this: ${subject}${styleNote}, wearing this exact outfit. Shot framing: ${framing || '3/4 shot, head to mid-thigh'}. Mood: ${moodText}. Platform: ${platText}. Include specific outfit details visible in the image. The subject's physical appearance must match the descriptor closely. End with: high resolution, professional fashion photography, 8k.` }
        ]}]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude error' });
    res.json({ prompt: data.content?.find(b => b.type === 'text')?.text?.trim() || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// OPENAI GPT-IMAGE-1 (multimodal — sends avatar + outfit as reference images)
app.post('/api/generate/openai', async (req, res) => {
  const { prompt, avatarBase64, avatarMediaType, outfitBase64, outfitMediaType, size = '1024x1024' } = req.body;
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'No OPENAI_API_KEY' });

  try {
    const hasImages = avatarBase64 || outfitBase64;

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

      addField('model', 'gpt-image-1');
      addField('prompt', prompt);
      addField('n', '1');
      addField('size', size);
      addField('quality', 'high');

      if (avatarBase64) addFile('image[]', 'avatar.jpg', avatarMediaType || 'image/jpeg', avatarBase64);
      if (outfitBase64) addFile('image[]', 'outfit.jpg', outfitMediaType || 'image/jpeg', outfitBase64);

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
      // Plain text generation fallback (no images)
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'high' })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'OpenAI error' });
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) return res.status(500).json({ error: 'No image returned from OpenAI' });
      return res.json({ imageBase64: b64 });
    }

  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GROK
app.post('/api/generate/grok', async (req, res) => {
  const { prompt } = req.body;
  if (!process.env.GROK_API_KEY) return res.status(503).json({ error: 'No GROK_API_KEY' });
  try {
    const r = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
      },
      body: JSON.stringify({ model: 'grok-imagine-image', prompt, n: 1 })
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

// GOOGLE IMAGEN
app.post('/api/generate/google', async (req, res) => {
  const { prompt } = req.body;
  if (!process.env.GOOGLE_API_KEY) return res.status(503).json({ error: 'No GOOGLE_API_KEY' });
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${process.env.GOOGLE_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '1:1', safetyFilterLevel: 'block_few', personGeneration: 'allow_adult' }
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Google error' });
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return res.status(500).json({ error: 'No image from Google' });
    res.json({ imageBase64: b64 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => console.log(`Virtual Closet running on port ${PORT}`));
