require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = new sqlite3.Database('./database.sqlite');
const PORT = process.env.PORT || 5001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --- 1. Database Initialization ---
db.serialize(() => {
  // Rounds Table
  db.run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roundNumber INTEGER UNIQUE,
      isActive INTEGER DEFAULT 1,
      endsAt DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Listings Table
  db.run(`
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      roundNumber INTEGER,
      fullName TEXT,
      headline TEXT,
      linkedinUrl TEXT,
      username TEXT,
      amountPaidCents INTEGER,
      isPaid INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Initialize Round 1 if none exists
  db.get(`SELECT * FROM rounds WHERE isActive = 1`, (err, row) => {
    if (!row) {
      const nextSunday = getNextSundayEnd();
      db.run(
        `INSERT INTO rounds (roundNumber, isActive, endsAt) VALUES (1, 1, ?)`,
        [nextSunday.toISOString()]
      );
    }
  });
});

function getNextSundayEnd() {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = (7 - day) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

// --- 2. Stripe Webhook (Raw Body parser before express.json) ---
app.post(
  '/api/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const listingId = session.metadata?.listingId;

      if (listingId) {
        db.run(
          `UPDATE listings SET isPaid = 1 WHERE id = ?`,
          [listingId],
          (err) => {
            if (err) console.error('Error updating paid status:', err);
            else console.log(`Listing ${listingId} marked as paid!`);
          }
        );
      }
    }

    res.json({ received: true });
  }
);

// Standard Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 3. API Endpoints ---

// Get current round information and rankings
app.get('/api/board', (req, res) => {
  db.get(`SELECT * FROM rounds WHERE isActive = 1`, (err, round) => {
    if (err || !round) return res.status(500).json({ error: 'No active round found' });

    db.all(
      `SELECT * FROM listings 
       WHERE roundNumber = ? AND isPaid = 1 
       ORDER BY amountPaidCents DESC`,
      [round.roundNumber],
      (err, listings) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          round,
          listings: listings || [],
        });
      }
    );
  });
});

// Create Bid & Stripe Checkout Session
app.post('/api/bid', async (req, res) => {
  const { fullName, headline, linkedinUrl, amountDollars } = req.body;

  const pattern = /^https:\/\/(www\.)?linkedin\.com\/(in|company)\/([a-zA-Z0-9_-]+)\/?$/;
  const match = (linkedinUrl || '').trim().match(pattern);

  const amount = parseFloat(amountDollars);
  if (!fullName || !headline || !match || isNaN(amount) || amount < 2) {
    return res.status(400).json({ error: 'Valid LinkedIn URL and minimum $2 bid required.' });
  }

  const username = match[3];
  const amountPaidCents = Math.round(amount * 100);
  const listingId = 'bid_' + Date.now();

  db.get(`SELECT roundNumber FROM rounds WHERE isActive = 1`, async (err, activeRound) => {
    if (err || !activeRound) {
      return res.status(500).json({ error: 'No active round found.' });
    }

    db.run(
      `INSERT INTO listings (id, roundNumber, fullName, headline, linkedinUrl, username, amountPaidCents, isPaid)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [listingId, activeRound.roundNumber, fullName.trim(), headline.trim(), linkedinUrl.trim(), username, amountPaidCents],
      async (dbErr) => {
        if (dbErr) return res.status(500).json({ error: dbErr.message });

        try {
          const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [
              {
                price_data: {
                  currency: 'usd',
                  product_data: {
                    name: `LinkedRank Spot - ${fullName}`,
                    description: headline.slice(0, 80),
                  },
                  unit_amount: amountPaidCents,
                },
                quantity: 1,
              },
            ],
            metadata: { listingId },
            success_url: `${BASE_URL}/?payment=success`,
            cancel_url: `${BASE_URL}/?payment=cancelled`,
          });

          res.json({ checkoutUrl: session.url });
        } catch (stripeErr) {
          console.error('Stripe error:', stripeErr);
          res.status(500).json({ error: stripeErr.message });
        }
      }
    );
  });
});

// --- 4. Sunday Reset Cron Job (Runs every Sunday at 23:59:00 UTC) ---
cron.schedule('59 23 * * 0', () => {
  console.log('Resetting weekly round...');
  db.get(`SELECT * FROM rounds WHERE isActive = 1`, (err, current) => {
    if (current) {
      db.run(`UPDATE rounds SET isActive = 0 WHERE id = ?`, [current.id]);
      const nextSunday = getNextSundayEnd();
      db.run(
        `INSERT INTO rounds (roundNumber, isActive, endsAt) VALUES (?, 1, ?)`,
        [current.roundNumber + 1, nextSunday.toISOString()]
      );
    }
  });
}, { timezone: 'UTC' });

app.listen(PORT, () => {
  console.log(`Server running at ${BASE_URL}`);
});