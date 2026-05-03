const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MessagingResponse, VoiceResponse } = require('twilio').twiml;
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://jma-bot.onrender.com';

// ── In-memory session stores ──
const sessions = {};      // voice sessions
const waSessions = {};    // whatsapp sessions

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Server running');
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

// ── Helper: extract first number from speech or text ──
function extractNumber(input) {
  if (!input) return null;
  const match = String(input).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ── Helper: map bedrooms to serviceType for API ──
function bedroomsToServiceType(bedrooms) {
  if (bedrooms === 0) return 'studio';
  if (bedrooms === 1) return '1bed';
  if (bedrooms === 2) return '2bed';
  return '3bed';
}

// ── Helper: Basic ZIP validation ──
function isValidZip(zip) {
  return /^\d{5}$/.test(zip);
}

// ── Helper: Map user cleaning type to API condition/extras ──
function mapTypeToCondition(type) {
  const t = type.toLowerCase();
  if (t.includes('deep') || t.includes('move')) return 'heavy';
  return 'normal';
}

// ── Step 1: Welcome → Ask for Service Type ──
app.post('/voice', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  sessions[callerId] = { step: 1 }; 

  console.log(`[Voice] Call Started - Caller: ${callerId}`);

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Hello, thanks for calling JMA Cleaning. I will help you get a quick quote and book your service.');

  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    action: `${BASE_URL}/voice/step-service`,
    method: 'POST',
    numDigits: 1
  });
  gather.say({ voice: 'Polly.Joanna' }, 'What type of cleaning do you need today? Press 1 for Regular, 2 for Deep cleaning, 3 for Move out, or 4 for Airbnb.');

  // Fallback if silent
  twiml.say({ voice: 'Polly.Joanna' }, "I didn't catch that. Please try again.");

  res.type('text/xml').send(twiml.toString());
});

// ── Step 2: Capture Service → Ask Bedrooms ──
app.post('/voice/step-service', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const digit = req.body?.Digits;
  const types = { '1': 'Regular', '2': 'Deep', '3': 'Move-out', '4': 'Airbnb' };
  
  const twiml = new VoiceResponse();
  if (!types[digit]) {
    const gather = twiml.gather({ input: 'speech dtmf', timeout: 5, action: `${BASE_URL}/voice/step-service`, method: 'POST', numDigits: 1 });
    gather.say({ voice: 'Polly.Joanna' }, "Sorry, that was an invalid selection. Press 1 for Regular, 2 for Deep, 3 for Move out, or 4 for Airbnb.");
    return res.type('text/xml').send(twiml.toString());
  }

  sessions[callerId].cleaningType = types[digit];
  
  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    action: `${BASE_URL}/voice/step-bedrooms`,
    method: 'POST'
  });
  gather.say({ voice: 'Polly.Joanna' }, `Great, a ${types[digit]} cleaning. How many bedrooms do you have? Say zero for a studio.`);

  res.type('text/xml').send(twiml.toString());
});

// ── Step 3: Capture Bedrooms → Ask Bathrooms ──
app.post('/voice/step-bedrooms', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const input = req.body?.Digits || req.body?.SpeechResult;
  const num = extractNumber(input);
  const twiml = new VoiceResponse();

  if (num === null) {
    const gather = twiml.gather({ input: 'speech dtmf', timeout: 5, action: `${BASE_URL}/voice/step-bedrooms`, method: 'POST' });
    gather.say({ voice: 'Polly.Joanna' }, "I didn't catch the number of bedrooms. Please tell me again.");
    return res.type('text/xml').send(twiml.toString());
  }

  sessions[callerId].bedrooms = num;
  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    action: `${BASE_URL}/voice/step-bathrooms`,
    method: 'POST'
  });
  gather.say({ voice: 'Polly.Joanna' }, `Got it, ${num === 0 ? 'a studio' : num + ' bedrooms'}. And how many bathrooms?`);

  res.type('text/xml').send(twiml.toString());
});

// ── Step 4: Capture Bathrooms → Ask Sqft ──
app.post('/voice/step-bathrooms', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const input = req.body?.Digits || req.body?.SpeechResult;
  const num = extractNumber(input);
  const twiml = new VoiceResponse();

  if (num === null) {
    const gather = twiml.gather({ input: 'speech dtmf', timeout: 5, action: `${BASE_URL}/voice/step-bathrooms`, method: 'POST' });
    gather.say({ voice: 'Polly.Joanna' }, "Please tell me the number of bathrooms again.");
    return res.type('text/xml').send(twiml.toString());
  }

  sessions[callerId].bathrooms = num;
  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    action: `${BASE_URL}/voice/step-sqft`,
    method: 'POST'
  });
  gather.say({ voice: 'Polly.Joanna' }, "Perfect. What is the approximate square footage of the place?");

  res.type('text/xml').send(twiml.toString());
});

// ── Step 5: Capture Sqft → Ask Condition ──
app.post('/voice/step-sqft', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const input = req.body?.Digits || req.body?.SpeechResult;
  const num = extractNumber(input);
  const twiml = new VoiceResponse();

  if (num === null || num < 100) {
    const gather = twiml.gather({ input: 'speech dtmf', timeout: 5, action: `${BASE_URL}/voice/step-sqft`, method: 'POST' });
    gather.say({ voice: 'Polly.Joanna' }, "I didn't catch the square footage. Please tell me the size in square feet.");
    return res.type('text/xml').send(twiml.toString());
  }

  sessions[callerId].sqft = num;
  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    action: `${BASE_URL}/voice/step-condition`,
    method: 'POST',
    numDigits: 1
  });
  gather.say({ voice: 'Polly.Joanna' }, "Got it. How would you describe the current condition? Press 1 for Light, 2 for Normal, or 3 for Heavy cleaning needed.");

  res.type('text/xml').send(twiml.toString());
});

// ── Step 6: Capture Condition → Suggest Extras ──
app.post('/voice/step-condition', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const digit = req.body?.Digits;
  const conditions = { '1': 'light', '2': 'normal', '3': 'heavy' };
  const twiml = new VoiceResponse();

  if (!conditions[digit]) {
    const gather = twiml.gather({ input: 'speech dtmf', timeout: 5, action: `${BASE_URL}/voice/step-condition`, method: 'POST', numDigits: 1 });
    gather.say({ voice: 'Polly.Joanna' }, "Invalid choice. Press 1 for Light, 2 for Normal, or 3 for Heavy.");
    return res.type('text/xml').send(twiml.toString());
  }

  sessions[callerId].condition = conditions[digit];
  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    action: `${BASE_URL}/voice/step-extras`,
    method: 'POST',
    numDigits: 1
  });
  gather.say({ voice: 'Polly.Joanna' }, "We also recommend adding a fridge or oven cleaning for the best results. Would you like to add any extras? Press 1 for Yes, or 2 for No.");

  res.type('text/xml').send(twiml.toString());
});

// ── Step 7: Capture Extras → Show Quote & Ask Booking ──
app.post('/voice/step-extras', async (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const digit = req.body?.Digits;
  const twiml = new VoiceResponse();

  const session = sessions[callerId];
  session.extras = (digit === '1') ? ['fridge', 'oven'] : []; // Simplified for voice

  try {
    const apiResponse = await axios.post(`${BASE_URL}/calculate-quote`, {
      serviceType: bedroomsToServiceType(session.bedrooms),
      sqft: session.sqft,
      bathrooms: session.bathrooms,
      zone: 'queens',
      condition: session.condition,
      extras: session.extras
    });

    session.price = apiResponse.data.totalPrice;
    
    twiml.say({ voice: 'Polly.Joanna' }, `Based on the details, your estimated quote is ${session.price} dollars.`);
    const gather = twiml.gather({
      input: 'speech dtmf',
      timeout: 5,
      action: `${BASE_URL}/voice/step-book`,
      method: 'POST',
      numDigits: 1
    });
    gather.say({ voice: 'Polly.Joanna' }, "Would you like to book this service? Press 1 for Yes, or 2 for No.");

  } catch (err) {
    console.error(err);
    twiml.say({ voice: 'Polly.Joanna' }, "Sorry, I had trouble calculating the price. One of our agents will call you back to help. Thank you for calling!");
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Step 8: Capture Booking → Ask Name ──
app.post('/voice/step-book', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const digit = req.body?.Digits;
  const twiml = new VoiceResponse();

  if (digit === '1') {
    const gather = twiml.gather({
      input: 'speech',
      timeout: 5,
      action: `${BASE_URL}/voice/step-confirm`,
      method: 'POST'
    });
    gather.say({ voice: 'Polly.Joanna' }, "Great! What is your full name?");
  } else {
    twiml.say({ voice: 'Polly.Joanna' }, "No problem. If you change your mind, feel free to call us back. Have a nice day!");
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Step 9: Capture Name → Final Confirmation ──
app.post('/voice/step-confirm', (req, res) => {
  const callerId = req.body?.From || 'unknown';
  const name = req.body?.SpeechResult;
  const twiml = new VoiceResponse();

  twiml.say({ voice: 'Polly.Joanna' }, `Thank you ${name || 'there'}. We have received your booking request for a ${sessions[callerId].cleaningType} cleaning. Our team will contact you shortly to confirm. Goodbye!`);
  twiml.hangup();

  console.log('NEW VOICE LEAD:', { from: callerId, ...sessions[callerId], name });
  delete sessions[callerId];

  res.type('text/xml').send(twiml.toString());
});

// ── WhatsApp Chatbot (Full Sales Flow) ───────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const from = req.body?.From || 'unknown';
  const body = (req.body?.Body || '').trim();
  const twiml = new MessagingResponse();

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
    
    // Auto-proceed to Step 8 (Calculation)
    twiml.message('Generating your personal quote... ⏳');
    // We trigger the calculation immediately in the next interaction or here.
    // For simplicity, we'll calculate now and show in Step 9.
    try {
      const apiResponse = await axios.post(`${BASE_URL}/calculate-quote`, {
        serviceType: bedroomsToServiceType(session.bedrooms),
        sqft: session.bedrooms * 250 + 400, // Estimate sqft if not provided
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
      twiml.message('Oops, something went wrong with the quote. Let me check with an agent. Reply YES if you still want to book.');
      session.step = 9;
    }
  }

  // ── Step 9 & 10: Booking Question ──
  else if (session.step === 9) {
    if (body.toLowerCase().includes('yes')) {
      session.step = 11;
      twiml.message('Great! We just need a few details to finalize. What is your *full name*?');
    } else {
      twiml.message('No problem! If you change your mind or have questions, just type HI to start over.');
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
        'An agent will reach out to you shortly to confirm everything. Thank you for choosing JMA Cleaning!'
      );
      // Log lead (in production this would go to a DB)
      console.log('NEW LEAD:', { from, ...session });
      delete waSessions[from];
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});