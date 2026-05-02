const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MessagingResponse } = require('twilio').twiml;

// ── In-memory session stores ──
const sessions = {};      // voice sessions
const waSessions = {};    // whatsapp sessions

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('JMA Bot Running');
});

// ── Cleaning Service Pricing ──────────────────────────────────────────
app.post('/calculate-quote', (req, res) => {
  const { serviceType, sqft, bathrooms, zone, condition, extras } = req.body;

  // ── normalize inputs (case-insensitive) ──
  const zoneLower = typeof zone === 'string' ? zone.toLowerCase() : zone;
  const conditionLower = typeof condition === 'string' ? condition.toLowerCase() : condition;

  // ── validation ──
  const basePrices = { studio: 110, '1bed': 130, '2bed': 160, '3bed': 190 };
  const minimumPrices = { studio: 120, '1bed': 135, '2bed': 165, '3bed': 195 };
  const zoneMultipliers = { manhattan: 1.2, brooklyn: 1.1, queens: 1.0 };
  const conditionFees = { light: 0, normal: 20, heavy: 80 };
  const extraPrices = { fridge: 25, oven: 30 };

  if (!basePrices[serviceType]) {
    return res.status(400).json({ error: `Invalid serviceType. Must be one of: ${Object.keys(basePrices).join(', ')}` });
  }
  if (typeof sqft !== 'number' || sqft <= 0) {
    return res.status(400).json({ error: 'sqft must be a positive number' });
  }
  if (typeof bathrooms !== 'number' || bathrooms < 0) {
    return res.status(400).json({ error: 'bathrooms must be a non-negative number' });
  }
  if (!zoneMultipliers[zoneLower]) {
    return res.status(400).json({ error: `Invalid zone. Must be one of: ${Object.keys(zoneMultipliers).join(', ')}` });
  }
  if (conditionFees[conditionLower] === undefined) {
    return res.status(400).json({ error: `Invalid condition. Must be one of: ${Object.keys(conditionFees).join(', ')}` });
  }
  if (extras && !Array.isArray(extras)) {
    return res.status(400).json({ error: 'extras must be an array' });
  }

  // ── calculation ──
  const base = basePrices[serviceType];
  const minimumPrice = minimumPrices[serviceType];
  const zoneMultiplier = zoneMultipliers[zoneLower];
  const sqftFactor = sqft * 0.05;
  const bathroomFee = bathrooms * 15;
  const conditionFee = conditionFees[conditionLower];

  let extrasFee = 0;
  const extrasBreakdown = {};
  if (extras && extras.length > 0) {
    for (const item of extras) {
      const itemLower = typeof item === 'string' ? item.toLowerCase() : item;
      if (!extraPrices[itemLower]) {
        return res.status(400).json({ error: `Invalid extra: "${item}". Must be one of: ${Object.keys(extraPrices).join(', ')}` });
      }
      extrasFee += extraPrices[itemLower];
      extrasBreakdown[itemLower] = extraPrices[itemLower];
    }
  }

  const calculatedPrice = (base * zoneMultiplier) + sqftFactor + bathroomFee + conditionFee + extrasFee;
  const totalPrice = Math.round(Math.max(minimumPrice, calculatedPrice));

  // ── response ──
  res.json({
    totalPrice,
    breakdown: {
      base,
      minimumPrice,
      zoneMultiplier,
      baseAfterZone: Math.round(base * zoneMultiplier * 100) / 100,
      sqftFactor,
      bathroomFee,
      conditionFee,
      extras: extrasBreakdown,
      extrasFee,
      calculatedPrice: Math.round(calculatedPrice * 100) / 100,
      minimumApplied: calculatedPrice < minimumPrice
    }
  });
});

// ── Helper: extract first number from speech ──
function extractNumber(input) {
  if (!input) return null;
  // If it's a string, look for digits
  const match = String(input).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ── Helper: map bedrooms to serviceType ──
function bedroomsToServiceType(bedrooms) {
  if (bedrooms === 0) return 'studio';
  if (bedrooms === 1) return '1bed';
  if (bedrooms === 2) return '2bed';
  return '3bed';
}

// ── Step 1: Welcome → Ask for bedrooms ──
app.post('/voice', (req, res) => {
  const callerId = req.body.From || 'unknown';
  sessions[callerId] = {}; // reset session

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">Hello, welcome to JMA Cleaning. I will help you get a quick quote.</Say>
      <Gather input="speech dtmf" timeout="5" action="/voice/step-bedrooms" method="POST" speechTimeout="auto" language="en-US">
        <Say voice="alice">How many bedrooms does your place have? Say zero for a studio.</Say>
      </Gather>
      <Say voice="alice">I didn't catch that, please try again.</Say>
      <Redirect>/voice</Redirect>
    </Response>
  `);
});

// ── Step 2: Capture bedrooms → Ask for bathrooms ──
app.post('/voice/step-bedrooms', (req, res) => {
  const callerId = req.body.From || 'unknown';
  const input = req.body.Digits || req.body.SpeechResult;
  const bedrooms = extractNumber(input);

  res.type('text/xml');
  if (bedrooms === null) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">I didn't catch that, please try again.</Say>
        <Gather input="speech dtmf" timeout="5" action="/voice/step-bedrooms" method="POST" speechTimeout="auto" language="en-US">
          <Say voice="alice">How many bedrooms? Say zero for a studio.</Say>
        </Gather>
        <Redirect>/voice/step-bedrooms</Redirect>
      </Response>
    `);
  }

  if (!sessions[callerId]) sessions[callerId] = {};
  sessions[callerId].bedrooms = bedrooms;

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">Got it, ${bedrooms === 0 ? 'a studio' : bedrooms + ' bedroom' + (bedrooms > 1 ? 's' : '')}.</Say>
      <Gather input="speech dtmf" timeout="5" action="/voice/step-bathrooms" method="POST" speechTimeout="auto" language="en-US">
        <Say voice="alice">How many bathrooms?</Say>
      </Gather>
      <Say voice="alice">I didn't catch that, please try again.</Say>
      <Redirect>/voice/step-bedrooms</Redirect>
    </Response>
  `);
});

// ── Step 3: Capture bathrooms → Ask for sqft ──
app.post('/voice/step-bathrooms', (req, res) => {
  const callerId = req.body.From || 'unknown';
  const input = req.body.Digits || req.body.SpeechResult;
  const bathrooms = extractNumber(input);

  res.type('text/xml');
  if (bathrooms === null) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">I didn't catch that, please try again.</Say>
        <Gather input="speech dtmf" timeout="5" action="/voice/step-bathrooms" method="POST" speechTimeout="auto" language="en-US">
          <Say voice="alice">How many bathrooms do you have?</Say>
        </Gather>
        <Redirect>/voice/step-bathrooms</Redirect>
      </Response>
    `);
  }

  if (!sessions[callerId]) sessions[callerId] = {};
  sessions[callerId].bathrooms = bathrooms;

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">Got it, ${bathrooms} bathroom${bathrooms !== 1 ? 's' : ''}.</Say>
      <Gather input="speech dtmf" timeout="5" action="/voice/step-sqft" method="POST" speechTimeout="auto" language="en-US">
        <Say voice="alice">What is the approximate square footage of your place?</Say>
      </Gather>
      <Say voice="alice">I didn't catch that, please try again.</Say>
      <Redirect>/voice/step-bathrooms</Redirect>
    </Response>
  `);
});

// ── Step 4: Capture sqft → Call pricing API → Speak quote ──
app.post('/voice/step-sqft', async (req, res) => {
  const callerId = req.body.From || 'unknown';
  const input = req.body.Digits || req.body.SpeechResult;
  const sqft = extractNumber(input);

  res.type('text/xml');
  if (sqft === null || sqft <= 0) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">I didn't catch that, please try again.</Say>
        <Gather input="speech dtmf" timeout="5" action="/voice/step-sqft" method="POST" speechTimeout="auto" language="en-US">
          <Say voice="alice">What is the square footage?</Say>
        </Gather>
        <Redirect>/voice/step-sqft</Redirect>
      </Response>
    `);
  }

  const session = sessions[callerId] || {};
  const bedrooms = session.bedrooms || 0;
  const bathrooms = session.bathrooms || 1;

  try {
    const apiResponse = await axios.post('https://jolty-turpentinic-sonia.ngrok-free.dev/calculate-quote', {
      serviceType: bedroomsToServiceType(bedrooms),
      sqft,
      bathrooms,
      zone: 'queens',
      condition: 'normal',
      extras: []
    });

    const price = apiResponse.data.totalPrice;

    // Clean up session
    delete sessions[callerId];

    res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">Based on ${bedrooms === 0 ? 'a studio' : bedrooms + ' bedroom' + (bedrooms > 1 ? 's' : '')}, ${bathrooms} bathroom${bathrooms !== 1 ? 's' : ''}, and ${sqft} square feet, your estimated price is ${price} dollars.</Say>
        <Pause length="1"/>
        <Say voice="alice">Would you like to book a cleaning? If yes, one of our agents will follow up with you shortly. Thank you for calling JMA Cleaning!</Say>
      </Response>
    `);
  } catch (error) {
    console.error('Pricing API error:', error.message);
    delete sessions[callerId];

    res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">Sorry, we encountered an error calculating your quote. Please try again later. Goodbye.</Say>
      </Response>
    `);
  }
});

// ── WhatsApp Chatbot ──────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const from = req.body.From || 'unknown';
  const body = (req.body.Body || '').trim();
  const twiml = new MessagingResponse();

  // Reset session if user sends "hi", "start", or "reset"
  if (/^(hi|hello|start|reset)$/i.test(body)) {
    waSessions[from] = { step: 1 };
    twiml.message('👋 Welcome to JMA Cleaning!\n\nHow many *bedrooms* does your place have? (Say 0 for a studio)');
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // If no session exists, treat as a reset
  if (!waSessions[from]) {
    waSessions[from] = { step: 1 };
    twiml.message('👋 Welcome to JMA Cleaning!\n\nHow many *bedrooms* does your place have? (Say 0 for a studio)');
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const session = waSessions[from];

  // ── Step 1: Bedrooms ──
  if (session.step === 1) {
    const number = extractNumber(body);
    if (number === null) {
      twiml.message('Please enter a valid number for bedrooms. (Say 0 for a studio)');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    session.bedrooms = number;
    session.step = 2;
    twiml.message(`Got it 👍, ${number === 0 ? 'a studio' : number + ' bedroom' + (number > 1 ? 's' : '')}.\n\nHow many *bathrooms*?`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // ── Step 2: Bathrooms ──
  if (session.step === 2) {
    const number = extractNumber(body);
    if (number === null) {
      twiml.message('Please enter a valid number for bathrooms.');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    session.bathrooms = number;
    session.step = 3;
    twiml.message(`Got it 👍, ${number} bathroom${number !== 1 ? 's' : ''}.\n\nWhat is the approximate *square footage*?`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // ── Step 3: Square footage → Calculate quote ──
  if (session.step === 3) {
    const number = extractNumber(body);
    if (number === null || number <= 0) {
      twiml.message('Please enter a valid square footage (e.g. 800).');
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    session.sqft = number;

    try {
      const apiResponse = await axios.post('https://jolty-turpentinic-sonia.ngrok-free.dev/calculate-quote', {
        serviceType: bedroomsToServiceType(session.bedrooms),
        sqft: session.sqft,
        bathrooms: session.bathrooms,
        zone: 'queens',
        condition: 'normal',
        extras: []
      });

      session.price = apiResponse.data.totalPrice;
      session.step = 4; // Move to booking prompt

      twiml.message(
        `Quote Ready ✅\n\n` +
        `🏠 ${session.bedrooms === 0 ? 'Studio' : session.bedrooms + ' Bedroom' + (session.bedrooms > 1 ? 's' : '')}\n` +
        `🛁 ${session.bathrooms} Bathroom${session.bathrooms !== 1 ? 's' : ''}\n` +
        `📐 ${session.sqft} sq ft\n\n` +
        `💰 Estimated Price: $${session.price}\n\n` +
        `Would you like to book? Reply YES to confirm or HI to restart.`
      );
    } catch (error) {
      console.error('WhatsApp pricing API error:', error.message);
      delete waSessions[from];
      twiml.message('Sorry, we encountered an error calculating your quote. Please reply HI to try again.');
    }

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // ── Step 4: Handle Booking Confirmation (YES) ──
  if (session.step === 4) {
    if (body.toUpperCase() === 'YES') {
      session.step = 5;
      twiml.message('Thanks! Please share your name.');
    } else {
      twiml.message('Reply YES to confirm your booking or HI to start over.');
    }
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // ── Step 5: Collect Name → Final Confirmation ──
  if (session.step === 5) {
    session.name = body;
    
    twiml.message(
      `Booking confirmed ✅\n` +
      `Name: ${session.name}\n` +
      `Bedrooms: ${session.bedrooms}\n` +
      `Bathrooms: ${session.bathrooms}\n` +
      `Sqft: ${session.sqft}\n` +
      `Estimated Price: $${session.price}\n\n` +
      `We will contact you shortly.`
    );

    // Clean up session after booking is complete
    delete waSessions[from];

    res.type('text/xml');
    return res.send(twiml.toString());
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});