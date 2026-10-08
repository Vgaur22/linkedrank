require('dotenv').config();
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 5001;

// 1. Initialize SQLite Database
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  // Create table if it doesn't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      headline TEXT NOT NULL,
      linkedin_url TEXT NOT NULL,
      amount INTEGER NOT NULL,
      badge_type TEXT DEFAULT 'open_to_work',
      skills TEXT DEFAULT '',
      is_paid INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Safe migration columns if table already existed without them
  db.run(`ALTER TABLE listings ADD COLUMN badge_type TEXT DEFAULT 'open_to_work'`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN skills TEXT DEFAULT ''`, () => {});
});

// 2. Stripe Webhook Endpoint (Must receive raw body for signature verification)
app.post(
  '/api/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('Webhook signature verification failed: No webhook secret value was provided.');
      return res.status(400).send('Webhook secret is not configured.');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bidId = session.metadata ? session.metadata.bidId : null;

      if (bidId) {
        db.run(
          `UPDATE listings SET is_paid = 1 WHERE id = ?`,
          [bidId],
          function (err) {
            if (err) {
              console.error('Error updating listing payment status:', err.message);
              return res.status(500).send('Database error');
            }
            console.log(`Listing ${bidId} marked as paid!`);
            return res.json({ received: true });
          }
        );
      } else {
        return res.json({ received: true });
      }
    } else {
      res.json({ received: true });
    }
  }
);

// 3. Middleware for regular routes
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4. API: Get Current Standings (Paid Only, Sorted by Bid Descending)
app.get('/api/standings', (req, res) => {
  const query = `
    SELECT id, name, headline, linkedin_url, amount, badge_type, skills, created_at
    FROM listings
    WHERE is_paid = 1
    ORDER BY amount DESC, created_at ASC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const topSpot = rows.length > 0 ? rows[0].amount : 0;
    res.json({ standings: rows, topSpot });
  });
});

// 5. API: Create Checkout Session
app.post('/api/checkout', async (req, res) => {
  const { name, headline, linkedin_url, amount, badge_type, skills } = req.body;

  if (!name || !headline || !linkedin_url || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const numericAmount = Math.max(1, parseInt(amount, 10));
  const bidId = `bid_${Date.now()}`;
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

  db.run(
    `INSERT INTO listings (id, name, headline, linkedin_url, amount, badge_type, skills, is_paid)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      bidId,
      name.trim(),
      headline.trim(),
      linkedin_url.trim(),
      numericAmount,
      badge_type || 'open_to_work',
      (skills || '').trim(),
    ],
    async (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: `LinkedRank Placement: ${name}`,
                  description: `${headline} [${badge_type}]`,
                },
                unit_amount: numericAmount * 100, // Stripe expects cents
              },
              quantity: 1,
            },
          ],
          mode: 'payment',
          metadata: { bidId },
          success_url: `${baseUrl}/?payment=success`,
          cancel_url: `${baseUrl}/?payment=cancelled`,
        });

        res.json({ url: session.url });
      } catch (stripeErr) {
        console.error('Stripe session creation error:', stripeErr.message);
        res.status(500).json({ error: stripeErr.message });
      }
    }
  );
});

// Fallback to index.html
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});