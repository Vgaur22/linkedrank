require('dotenv').config();
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');
const { Resend } = require('resend');
const cron = require('node-cron');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const PORT = process.env.PORT || 5001;

// Exchange rates to 1 USD for fair leaderboard sorting
const USD_RATES = {
  usd: 1.0,
  eur: 1.08,
  gbp: 1.28,
  inr: 0.012
};

// 1. Initialize SQLite Database
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  // Main Listings Table
  db.run(`
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      headline TEXT NOT NULL,
      linkedin_url TEXT NOT NULL,
      amount REAL NOT NULL,
      original_amount REAL,
      currency TEXT DEFAULT 'usd',
      badge_type TEXT DEFAULT 'open_to_work',
      location TEXT DEFAULT 'germany',
      german_level TEXT DEFAULT 'None',
      skills TEXT DEFAULT '',
      email TEXT DEFAULT '',
      is_paid INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Hall of Fame Table for weekly tournament winners
  db.run(`
    CREATE TABLE IF NOT EXISTS hall_of_fame (
      id TEXT PRIMARY KEY,
      round_number INTEGER DEFAULT 1,
      rank_position INTEGER,
      name TEXT,
      headline TEXT,
      linkedin_url TEXT,
      email TEXT,
      amount REAL,
      ended_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrations for existing deployments
  db.run(`ALTER TABLE listings ADD COLUMN badge_type TEXT DEFAULT 'open_to_work'`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN skills TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN original_amount REAL`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN currency TEXT DEFAULT 'usd'`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN location TEXT DEFAULT 'germany'`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN german_level TEXT DEFAULT 'None'`, () => {});
  db.run(`ALTER TABLE listings ADD COLUMN email TEXT DEFAULT ''`, () => {});
});

// Helper: Send Outbid Notification Email
async function sendOutbidEmail(previousLeader, newLeaderName, newAmountUsd) {
  if (!resend) {
    console.log('[Notification Skipped] RESEND_API_KEY not configured.');
    return;
  }
  if (!previousLeader.email) {
    console.log(`[Notification Skipped] No email stored for previous #1 (${previousLeader.name}).`);
    return;
  }

  const siteUrl = process.env.BASE_URL || 'https://linkedrank.onrender.com';

  try {
    await resend.emails.send({
      from: 'LinkedRank <onboarding@resend.dev>',
      to: previousLeader.email,
      subject: `🚨 You just got outbid on LinkedRank!`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0b0f19; color: #f1f5f9; border-radius: 16px;">
          <h2 style="color: #f59e0b; margin-top: 0;">👑 You lost the #1 Spotlight!</h2>
          <p style="font-size: 15px; line-height: 1.5; color: #cbd5e1;">
            Hey <strong>${previousLeader.name}</strong>,
          </p>
          <p style="font-size: 15px; line-height: 1.5; color: #cbd5e1;">
            <strong>${newLeaderName}</strong> just placed a bid ($${newAmountUsd.toFixed(2)} USD) and claimed the <strong>#1 Spotlight spot</strong> on LinkedRank.
          </p>
          <p style="font-size: 14px; line-height: 1.5; color: #94a3b8;">
            Your profile has moved down to #2. This week's tournament resets Sunday at 00:00 UTC, and recruiters are scouting the top of the board right now.
          </p>
          <div style="margin: 28px 0; text-align: center;">
            <a href="${siteUrl}" style="background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: bold; font-size: 14px; display: inline-block;">
              Reclaim Your #1 Rank ↗
            </a>
          </div>
          <hr style="border: 0; border-top: 1px solid #1e293b; margin: 24px 0;" />
          <p style="font-size: 11px; color: #64748b; text-align: center;">
            LinkedRank Spotlight &bull; Resets weekly every Sunday &bull; Instant ATS Bypass
          </p>
        </div>
      `
    });
    console.log(`[Outbid Email Sent] Notified ${previousLeader.email} that ${newLeaderName} took #1.`);
  } catch (err) {
    console.error('[Outbid Email Error]', err.message);
  }
}

// 2. Automated Sunday Tournament Reset & Winner Cron (Every Sunday 23:59:59 UTC)
cron.schedule('59 59 23 * * 0', () => {
  console.log('[Tournament Reset] Closing weekly tournament and declaring podium winners...');

  db.all(
    `SELECT id, name, headline, linkedin_url, email, amount 
     FROM listings 
     WHERE is_paid = 1 
     ORDER BY amount DESC, created_at ASC 
     LIMIT 3`,
    [],
    (err, topWinners) => {
      if (err || !topWinners || topWinners.length === 0) {
        console.log('[Tournament Reset] No active paid entries to archive.');
        return;
      }

      topWinners.forEach((winner, idx) => {
        const rank = idx + 1;
        const hofId = `hof_${Date.now()}_${rank}`;

        // Save to Hall of Fame
        db.run(
          `INSERT INTO hall_of_fame (id, round_number, rank_position, name, headline, linkedin_url, email, amount)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
          [hofId, rank, winner.name, winner.headline, winner.linkedin_url, winner.email, winner.amount]
        );

        // Send celebration email to winner
        if (winner.email && resend) {
          const siteUrl = process.env.BASE_URL || 'https://linkedrank.onrender.com';
          resend.emails.send({
            from: 'LinkedRank <onboarding@resend.dev>',
            to: winner.email,
            subject: `🏆 Official Podium Finish: You Won Rank #${rank} on LinkedRank!`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0b0f19; color: #f1f5f9; border-radius: 16px;">
                <h2 style="color: #f59e0b; margin-top: 0;">🏆 Official Podium Finish!</h2>
                <p style="font-size: 15px; color: #cbd5e1;">Hey <strong>${winner.name}</strong>,</p>
                <p style="font-size: 15px; color: #cbd5e1;">
                  The weekly tournament has ended and you officially held <strong>Rank #${rank}</strong>! Your profile has been inducted into the permanent LinkedRank Hall of Fame.
                </p>
                <div style="background: #1e293b; padding: 18px; border-radius: 12px; margin: 24px 0; border: 1px solid #334155;">
                  <strong style="color: #38bdf8; display: block; margin-bottom: 6px;">Share your win on LinkedIn:</strong>
                  <p style="font-size: 13px; color: #e2e8f0; font-style: italic; line-height: 1.5;">
                    "Finished at Rank #${rank} on LinkedRank's weekly spotlight board 🏆 Open for engineering and tech opportunities in Germany / Global Remote. Check the board: ${siteUrl}"
                  </p>
                </div>
                <div style="text-align: center; margin: 24px 0;">
                  <a href="${siteUrl}" style="background: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; font-size: 13px; display: inline-block;">
                    View Live Hall of Fame ↗
                  </a>
                </div>
                <hr style="border: 0; border-top: 1px solid #1e293b; margin: 20px 0;" />
                <p style="font-size: 11px; color: #64748b; text-align: center;">LinkedRank Spotlight &bull; Hall of Fame &bull; Sunday Reset</p>
              </div>
            `
          }).catch(mailErr => console.error('[Winner Email Error]', mailErr.message));
        }
      });

      console.log(`[Tournament Reset] Completed successfully. Archived ${topWinners.length} winners.`);
    }
  );
}, {
  timezone: "UTC"
});

// 3. Stripe Webhook Endpoint
app.post(
  '/api/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('Webhook secret is not configured.');
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
      const customerEmail = session.customer_details ? session.customer_details.email : '';

      if (bidId) {
        // Step A: Find who is CURRENTLY at #1 before activating the new bid
        db.get(
          `SELECT id, name, email, amount FROM listings WHERE is_paid = 1 ORDER BY amount DESC, created_at ASC LIMIT 1`,
          [],
          (err, previousLeader) => {
            if (err) console.error('Error fetching current leader:', err);

            // Step B: Mark the new bid as paid and save customer's email from Stripe
            db.run(
              `UPDATE listings SET is_paid = 1, email = ? WHERE id = ?`,
              [customerEmail, bidId],
              function (updateErr) {
                if (updateErr) {
                  console.error('Error updating listing payment status:', updateErr.message);
                  return res.status(500).send('Database error');
                }
                console.log(`Listing ${bidId} marked as paid! Email: ${customerEmail}`);

                // Step C: Check if this new bid dethroned the previous #1
                db.get(`SELECT id, name, amount FROM listings WHERE id = ?`, [bidId], (fetchErr, newBid) => {
                  if (!fetchErr && newBid && previousLeader) {
                    if (previousLeader.id !== newBid.id && newBid.amount > previousLeader.amount) {
                      sendOutbidEmail(previousLeader, newBid.name, newBid.amount);
                    }
                  }
                });

                return res.json({ received: true });
              }
            );
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

// 4. Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 5. API: Standings
app.get('/api/standings', (req, res) => {
  const query = `
    SELECT id, name, headline, linkedin_url, amount, original_amount, currency, badge_type, location, german_level, skills, created_at
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

// 6. API: Checkout Session
app.post('/api/checkout', async (req, res) => {
  const { 
    name, 
    headline, 
    linkedin_url, 
    amount, 
    currency = 'usd', 
    badge_type, 
    location = 'germany', 
    german_level = 'None', 
    skills 
  } = req.body;

  if (!name || !headline || !linkedin_url || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const selectedCurrency = currency.toLowerCase();
  const rate = USD_RATES[selectedCurrency] || 1.0;
  const rawAmount = Math.max(1, parseFloat(amount));
  const normalizedUsd = Math.round(rawAmount * rate * 100) / 100;

  const bidId = `bid_${Date.now()}`;
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

  db.run(
    `INSERT INTO listings (id, name, headline, linkedin_url, amount, original_amount, currency, badge_type, location, german_level, skills, is_paid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      bidId,
      name.trim(),
      headline.trim(),
      linkedin_url.trim(),
      normalizedUsd,
      rawAmount,
      selectedCurrency,
      badge_type || 'open_to_work',
      location,
      german_level,
      (skills || '').trim(),
    ],
    async (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      try {
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: selectedCurrency,
                product_data: {
                  name: `LinkedRank Spotlight: ${name}`,
                  description: `${headline} [${location.toUpperCase()}]`,
                },
                unit_amount: Math.round(rawAmount * 100),
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

// 7. API: Hall of Fame (Past Winners)
app.get('/api/hall-of-fame', (req, res) => {
  db.all(
    `SELECT round_number, rank_position, name, headline, linkedin_url, amount, ended_at 
     FROM hall_of_fame 
     ORDER BY round_number DESC, rank_position ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ winners: rows || [] });
    }
  );
});

// 8. Catch-All Route
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});