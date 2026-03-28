const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS — allow your Vercel app
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// VAPID keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'A0IABKpGcJyGslrLGQmvQXwNm0BhrzEP9RMISt2_EaJT4UHRtibqows7ZdayxvqprtG56kvCaHrBXZEo6w7r4koqpj8';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '5IV-6-r80J8P_MTW5q2twH-3KuLGFOO2SbnKau0WU0Y';
const VAPID_EMAIL   = process.env.VAPID_EMAIL   || 'mailto:pawtraks@master.com';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// Simple file-based storage
var DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { subscriptions: {}, schedules: {} };
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d)); } catch(e) {}
}

var db = loadData();

// Helper: send push to a subscription
async function sendPush(sub, title, body, tag) {
  try {
    await webpush.sendNotification(sub, JSON.stringify({
      title: title,
      body: body,
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag: tag,
      data: { url: '/' }
    }));
    return true;
  } catch(e) {
    // 410 = subscription expired/invalid
    if (e.statusCode === 410) return 'expired';
    console.log('Push error:', e.statusCode, e.message);
    return false;
  }
}

// Helper: age-based cooldowns (ms)
function getFeedCooldown(age) {
  if (age < 0.083) return 0.5 * 3600000;
  if (age < 0.5)   return 1.5 * 3600000;
  if (age < 1)     return 2   * 3600000;
  if (age < 3)     return 3   * 3600000;
  if (age < 8)     return 4   * 3600000;
  return               5   * 3600000;
}
function getOutsideCooldown(age) {
  if (age < 0.5) return 0.5 * 3600000;
  if (age < 1)   return 1   * 3600000;
  if (age < 3)   return 1.5 * 3600000;
  if (age < 8)   return 2   * 3600000;
  return             3   * 3600000;
}

// ── Routes ──────────────────────────────────────────────

// Health check
app.get('/', function(req, res) {
  res.json({ status: 'PawTraks push server running', subs: Object.keys(db.subscriptions).length });
});

// Save push subscription from browser
app.post('/subscribe', function(req, res) {
  var { userId, subscription } = req.body;
  if (!userId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing userId or subscription' });
  }
  db.subscriptions[userId] = subscription;
  saveData(db);
  console.log('Subscription saved for user:', userId);
  res.json({ ok: true });
});

// Save dog schedule from app
app.post('/schedule', function(req, res) {
  var { userId, dogs } = req.body;
  if (!userId || !Array.isArray(dogs)) {
    return res.status(400).json({ error: 'Missing userId or dogs' });
  }
  db.schedules[userId] = { dogs: dogs, updatedAt: Date.now() };
  saveData(db);
  res.json({ ok: true });
});

// Remove subscription (on logout)
app.post('/unsubscribe', function(req, res) {
  var { userId } = req.body;
  if (userId) {
    delete db.subscriptions[userId];
    delete db.schedules[userId];
    saveData(db);
  }
  res.json({ ok: true });
});

// Get VAPID public key (app needs this to subscribe)
app.get('/vapid-public-key', function(req, res) {
  res.json({ key: VAPID_PUBLIC });
});

// ── Notification scheduler (runs every 5 minutes) ───────
cron.schedule('*/5 * * * *', async function() {
  var now = Date.now();
  var userIds = Object.keys(db.schedules);

  for (var i = 0; i < userIds.length; i++) {
    var userId = userIds[i];
    var sub = db.subscriptions[userId];
    if (!sub) continue;

    var schedule = db.schedules[userId];
    var dogs = schedule.dogs || [];

    for (var j = 0; j < dogs.length; j++) {
      var dog = dogs[j];
      var age = parseFloat(dog.age) || 1;
      var name = dog.name;
      var feedCd = getFeedCooldown(age);
      var outCd  = getOutsideCooldown(age);

      // Food reminder
      var lastFed = dog.lastFed ? new Date(dog.lastFed).getTime() : 0;
      var fedOverdueMs = now - lastFed - feedCd;
      if (fedOverdueMs >= 0 && fedOverdueMs < 5 * 60000) {
        var result = await sendPush(sub,
          '🍽️ Time to feed ' + name + '!',
          name + ' is due for their next meal. Tap to log it in PawTraks.',
          'feed-' + dog.id
        );
        if (result === 'expired') { delete db.subscriptions[userId]; saveData(db); break; }
      }

      // Water reminder
      var lastWater = dog.lastWater ? new Date(dog.lastWater).getTime() : 0;
      var waterOverdueMs = now - lastWater - feedCd;
      if (waterOverdueMs >= 0 && waterOverdueMs < 5 * 60000) {
        await sendPush(sub,
          '💧 ' + name + ' needs water!',
          "Make sure " + name + "'s water bowl is fresh. Tap to log it in PawTraks.",
          'water-' + dog.id
        );
      }

      // Outside reminder
      var lastOut = dog.lastOutside ? new Date(dog.lastOutside).getTime() : 0;
      var outOverdueMs = now - lastOut - outCd;
      if (outOverdueMs >= 0 && outOverdueMs < 5 * 60000) {
        await sendPush(sub,
          '🌳 ' + name + ' needs to go outside!',
          name + ' is due for an outdoor break. Tap to log it in PawTraks.',
          'outside-' + dog.id
        );
      }

      // Vet appointment reminders
      var appts = dog.vetAppointments || [];
      for (var k = 0; k < appts.length; k++) {
        var appt = appts[k];
        if (!appt.date) continue;
        var apptMs = new Date(appt.date).getTime();
        var hoursUntil = (apptMs - now) / 3600000;
        // Remind at 24h and 2h before
        if ((hoursUntil <= 24 && hoursUntil > 23.9) || (hoursUntil <= 2 && hoursUntil > 1.9)) {
          var when = hoursUntil > 3 ? 'tomorrow' : 'in 2 hours';
          await sendPush(sub,
            '🩺 Vet appointment ' + when + '!',
            name + ': ' + (appt.reason || 'Vet visit') + (appt.vet ? ' with ' + appt.vet : ''),
            'vet-' + appt.id
          );
        }
      }
    }
  }
});

// Daily 8 AM wellness reminder
cron.schedule('0 8 * * *', async function() {
  var userIds = Object.keys(db.subscriptions);
  var messages = [
    "Don't forget to log your dogs' meals and walks today! 🐾",
    "Good morning! Your pups are counting on you today 🐕",
    "Rise and shine! Time to take care of your pack. Open PawTraks to get started. 🌅",
    "Start your day right — log your dogs' morning routine in PawTraks! ☀️",
  ];

  for (var i = 0; i < userIds.length; i++) {
    var userId = userIds[i];
    var sub = db.subscriptions[userId];
    var schedule = db.schedules[userId];
    if (!sub || !schedule) continue;
    var msg = messages[Math.floor(Math.random() * messages.length)];
    await sendPush(sub, '🌟 Good Morning from PawTraks!', msg, 'daily-wellness');
  }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('PawTraks push server running on port ' + PORT);
});
