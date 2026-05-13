require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const WebSocket = require('ws');
const { MessagingResponse, VoiceResponse } = require('twilio').twiml;

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = "https://jma-bot.onrender.com";

const REQUIRED_ENV_VARS = [
  'OPENAI_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'DOMAIN'
];

REQUIRED_ENV_VARS.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`CRITICAL: Missing ${varName} in environment variables`);
  }
});

// ── In-memory session stores ──
const sessions = {};      // voice sessions
const waSessions = {};    // whatsapp sessions

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── AI Prompt Configuration ──
const SYSTEM_MESSAGE = `
You are a professional, friendly, and sales-oriented human receptionist for "JMA Cleaning". 
Your goal is to help customers get a cleaning quote and book a service.

BEHAVIOR:
1. Be polite and professional. Sound like a real person, not a robot.
2. If the user mentions details (bedrooms, zip code, etc.), remember them.
3. Collect the following details naturally:
   - Service type (Regular, Deep, Move-out, Airbnb)
   - ZIP code or location
   - Number of bedrooms (0 for studio)
   - Number of bathrooms
   - Condition of the place (Light, Normal, Heavy)
   - Extras (Fridge, Oven)
4. Once you have enough details, use the "calculate_quote" tool to get a price.
5. Present the price and suggest extras if they haven't picked any.
6. Ask if they'd like to schedule the booking.
7. If they say yes, collect their full name, address, and preferred date/time.
8. Finally, use the "book_service" tool to save the booking.

HANDOFF:
- If the user is angry, confused, or asks for a human, say you'll transfer them or take a message.

LANGUAGE:
- Detect the caller's language from their first sentence.
- Continue the conversation in the same language naturally.
- Use a professional and friendly tone.
- If the language is unclear, politely ask which language they prefer.

CONSTRAINTS:
- Keep responses concise for low latency.
- Do not repeat questions if already answered.
`;

const VOICE = 'shimmer'; // Options: alloy, echo, shimmer, verse

// ── Cleaning Service Pricing Logic (Internal API) ──
app.post('/calculate-quote', (req, res) => {
  const { serviceType, sqft, bathrooms, zone, condition, extras } = req.body;
  
  const zoneLower = typeof zone === 'string' ? zone.toLowerCase() : 'queens';
  const conditionLower = typeof condition === 'string' ? condition.toLowerCase() : 'normal';

  const basePrices = { studio: 110, '1bed': 130, '2bed': 160, '3bed': 190 };
  const minimumPrices = { studio: 120, '1bed': 135, '2bed': 165, '3bed': 195 };
  const zoneMultipliers = { manhattan: 1.2, brooklyn: 1.1, queens: 1.0 };
  const conditionFees = { light: 0, normal: 20, heavy: 80 };
  const extraPrices = { fridge: 25, oven: 30 };

  const sType = basePrices[serviceType] ? serviceType : '1bed';
  const base = basePrices[sType];
  const minimumPrice = minimumPrices[sType];
  const zoneMultiplier = zoneMultipliers[zoneLower] || 1.0;
  const sqftFactor = (sqft || 500) * 0.05;
  const bathroomFee = (bathrooms || 1) * 15;
  const conditionFee = conditionFees[conditionLower] || 20;

  let extrasFee = 0;
  if (extras && Array.isArray(extras)) {
    extras.forEach(item => {
      extrasFee += extraPrices[item.toLowerCase()] || 0;
    });
  }

  const calculatedPrice = (base * zoneMultiplier) + sqftFactor + bathroomFee + conditionFee + extrasFee;
  const totalPrice = Math.round(Math.max(minimumPrice, calculatedPrice));

  res.json({ totalPrice });
});

// ── Twilio Voice Webhook ──
app.get('/voice', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello, welcome to JMA Cleaning. Please call us to speak with our assistant.</Say>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${process.env.DOMAIN}/media-stream`,
  });

  res.type('text/xml').send(twiml.toString());
});

// ── Helper: Map bedrooms to serviceType ──
function bedroomsToServiceType(bedrooms) {
  if (bedrooms === 0) return 'studio';
  if (bedrooms === 1) return '1bed';
  if (bedrooms === 2) return '2bed';
  return '3bed';
}

// ── WhatsApp Chatbot (Full Sales Flow) ──
app.post('/whatsapp', async (req, res) => {
  const from = req.body?.From || 'unknown';
  const body = (req.body?.Body || '').trim();
  const twiml = new MessagingResponse();

  const extractNumber = (input) => {
    if (!input) return null;
    const match = String(input).match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  };

  const resetKeywords = /^(hi|hello|start|reset|menu)$/i;
  if (resetKeywords.test(body) || !waSessions[from]) {
    waSessions[from] = { step: 1 };
    twiml.message(
      '✨ *Welcome to JMA Cleaning!* ✨\n' +
      'Your partner for a spotless home.\n\n' +
      'What type of cleaning do you need today?\n' +
      '1️⃣ *Regular*\n' +
      '2️⃣ *Deep*\n' +
      '3️⃣ *Move-out*\n' +
      '4️⃣ *Airbnb*'
    );
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const session = waSessions[from];

  // ── Step 1: Cleaning Type ──
  if (session.step === 1) {
    const types = { '1': 'Regular', '2': 'Deep', '3': 'Move-out', '4': 'Airbnb' };
    const selection = extractNumber(body);
    if (!selection || !types[selection]) {
      twiml.message('Please select a valid option (1-4) or type the cleaning style.');
    } else {
      session.cleaningType = types[selection];
      session.step = 2;
      twiml.message(`Excellent choice! A *${session.cleaningType}* cleaning it is. 🧼\n\nWhat is your *ZIP code* or general location?`);
    }
  }

  // ── Step 2: Location ──
  else if (session.step === 2) {
    if (body.length < 3) {
      twiml.message('Please provide a valid ZIP code or neighborhood name.');
    } else {
      session.zip = body;
      session.step = 3;
      twiml.message('Got it. Now, how many *bedrooms* does your place have? (Say 0 for a studio)');
    }
  }

  // ── Step 3: Size (Bedrooms/Sqft) ──
  else if (session.step === 3) {
    const num = extractNumber(body);
    if (num === null) {
      twiml.message('Please enter a number for the bedrooms.');
    } else {
      session.bedrooms = num;
      session.step = 4;
      twiml.message('Perfect. And how many *bathrooms*?');
    }
  }

  // ── Step 4: Bathrooms ──
  else if (session.step === 4) {
    const num = extractNumber(body);
    if (num === null) {
      twiml.message('Please enter the number of bathrooms.');
    } else {
      session.bathrooms = num;
      session.step = 5;
      twiml.message(
        'How would you describe the current *condition* of your place?\n' +
        '1. *Light* (Well maintained)\n' +
        '2. *Normal* (Standard living)\n' +
        '3. *Heavy* (Needs a lot of love)'
      );
    }
  }

  // ── Step 5: Condition ──
  else if (session.step === 5) {
    const conditions = { '1': 'light', '2': 'normal', '3': 'heavy' };
    const selection = extractNumber(body);
    if (!selection || !conditions[selection]) {
      twiml.message('Please select 1, 2, or 3.');
    } else {
      session.condition = conditions[selection];
      session.step = 6;
      twiml.message(
        '✨ *Smart Recommendation* ✨\n' +
        'Our customers often love adding a *Fridge* or *Oven* deep clean for just $25-$30 extra.\n\n' +
        'Would you like to include any extras? (Reply NO or tell me what to add, e.g., "Fridge")'
      );
    }
  }

  // ── Step 6: Extras ──
  else if (session.step === 6) {
    session.extras = [];
    if (body.toLowerCase().includes('fridge')) session.extras.push('fridge');
    if (body.toLowerCase().includes('oven')) session.extras.push('oven');
    
    session.step = 7;
    twiml.message('Noted! 📝 When would be your *preferred date and time* for the cleaning?');
  }

  // ── Step 7: Date & Time ──
  else if (session.step === 7) {
    session.date = body;
    session.step = 8;
    
    twiml.message('Generating your personal quote... ⏳');
    try {
      const apiResponse = await axios.post(`${BASE_URL}/calculate-quote`, {
        serviceType: bedroomsToServiceType(session.bedrooms),
        sqft: session.bedrooms * 250 + 400,
        bathrooms: session.bathrooms,
        zone: 'queens',
        condition: session.condition,
        extras: session.extras
      });
      session.price = apiResponse.data.totalPrice;
      session.step = 9;
      twiml.message(
        `💰 *Your Estimated Quote:* $${session.price}\n\n` +
        `This includes a ${session.cleaningType} cleaning for a ${session.bedrooms}BR home on ${session.date}.\n\n` +
        'Would you like to *book this service*? (Yes/No)'
      );
    } catch (err) {
      console.error(err);
      twiml.message('Oops, something went wrong with the quote. Let me check with an agent.');
      session.step = 9;
    }
  }

  // ── Step 9 & 10: Booking Question ──
  else if (session.step === 9) {
    if (body.toLowerCase().includes('yes')) {
      session.step = 11;
      twiml.message('Great! We just need a few details to finalize. What is your *full name*?');
    } else {
      twiml.message('No problem! If you change your mind, just type HI to start over.');
      delete waSessions[from];
    }
  }

  // ── Step 11: Collect Personal Data ──
  else if (session.step === 11) {
    if (!session.name) {
      session.name = body;
      twiml.message(`Thanks, ${session.name}! And what is the *full address* for the cleaning?`);
    } else {
      session.address = body;
      session.step = 12;
      twiml.message(
        '✅ *Booking Received!* ✅\n\n' +
        `We have your ${session.cleaningType} cleaning scheduled for ${session.date}.\n\n` +
        'An agent will reach out to you shortly to confirm everything.'
      );
      console.log('NEW LEAD:', { from, ...session });
      delete waSessions[from];
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ── WebSocket Server for Twilio Media Streams ──
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('[Twilio] Media Stream Connected');

  let streamSid = null;
  let openAiWs = null;

  // Initialize OpenAI Realtime Connection
  const connectToOpenAI = () => {
    openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    openAiWs.on('open', () => {
      console.log('[OpenAI] Connected');
      
      // Send session configuration
      // Minimal session config — tools and turn_detection removed to isolate disconnect cause
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw'
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    });

    openAiWs.on('message', async (data) => {
      let response;

      try {
        const messageString = data.toString();
        response = JSON.parse(messageString);
      } catch (err) {
        console.error('[OpenAI] Failed to parse websocket message:', err);
        return;
      }

      // Handle audio from OpenAI
      if (response.type === 'response.audio.delta' && response.delta) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          }));
        }
      }

      // Handle function calls
      if (response.type === 'response.done') {
        const output = response?.response?.output || [];
        for (const item of output) {
          if (item.type === 'function_call') {
            const { name, arguments: argsString, call_id } = item;
            const args = JSON.parse(argsString);

            let functionResult;
            if (name === 'calculate_quote') {
              console.log('[AI] Calculating quote:', args);
              try {
                const quoteRes = await axios.post(`${BASE_URL}/calculate-quote`, args);
                functionResult = { price: quoteRes.data.totalPrice };
              } catch (err) {
                functionResult = { error: 'Failed to calculate quote' };
              }
            } else if (name === 'book_service') {
              console.log('[AI] Booking service:', args);
              // Lead capture logic here
              functionResult = { status: 'success', message: 'Booking saved' };
            }

            // Send tool result back to OpenAI
            const toolResponse = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: call_id,
                output: JSON.stringify(functionResult)
              }
            };
            openAiWs.send(JSON.stringify(toolResponse));
            
            // Ask OpenAI to generate a response after tool execution
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
          }
        }
      }

      // Handle Interruption (Twilio needs to clear its buffer)
      if (response.type === 'input_audio_buffer.speech_started') {
        console.log('[AI] User started speaking, stopping response');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
        }
        // OpenAI natively stops audio generation when speech is detected via server_vad
      }
    });

    openAiWs.on('close', (code, reason) => {
      console.error('[OpenAI] Closed:', code, reason?.toString());
    });

    openAiWs.on('error', (error) => {
      console.error('[OpenAI] WebSocket Error:', error);
    });
  };

  connectToOpenAI();

  ws.on('message', (data) => {
    let message;

    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      console.error('[Twilio] Failed to parse websocket message:', err);
      return;
    }

    switch (message.event) {
      case 'start':
        streamSid = message.start.streamSid;
        console.log(`[Twilio] Stream Started: ${streamSid}`);
        // Trigger greeting only after Twilio media stream is fully ready
        setTimeout(() => {
          if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                instructions: 'Greet the caller warmly and ask how you can help with cleaning services today.'
              }
            }));
          }
        }, 1500);
        break;
      case 'media':
        // Forward audio to OpenAI
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          const audioAppend = {
            type: 'input_audio_buffer.append',
            audio: message.media.payload
          };
          openAiWs.send(JSON.stringify(audioAppend));
        }
        break;
      case 'stop':
        console.log(`[Twilio] Stream Stopped: ${streamSid}`);
        if (openAiWs) openAiWs.close();
        break;
    }
  });

  ws.on('close', () => {
    console.log('[Twilio] Media Stream Closed');
    if (openAiWs) openAiWs.close();
  });
});