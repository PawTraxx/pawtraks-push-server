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
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BDog6Dq3O44SgyVZhKYL2ypqykH02_BBLdYEIAZiuhCQbcVdWWm-t6dkQirES-SgzUK06lQVyvidyC9p7tGVNeU';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'lv5NXDWuxy8RfCsuZUVJGfZ7T8AV1gPcD-pHhL7daas';
const VAPID_EMAIL   = process.env.VAPID_EMAIL   || 'mailto:pawtraks@master.com';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// Simple file-based storage — uses persistent volume at /app/data
var DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
var DATA_FILE = path.join(DATA_DIR, 'data.json');
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
    console.log('Push sent:', tag);
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
  if (age < 8)   return 4   * 3600000;
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
  console.log('Schedule saved for user:', userId, '— dogs:', dogs.length);
  res.json({ ok: true });
});

// Remove subscription (on logout)
app.post('/unsubscribe', function(req, res) {
  var { userId } = req.body;
  if (userId) {
    delete db.subscriptions[userId];
    delete db.schedules[userId];
    saveData(db);
    console.log('Unsubscribed user:', userId);
  }
  res.json({ ok: true });
});

// Clear lastNotified for a user — forces next cron to send notifications
app.post('/clear-notified', function(req, res) {
  var { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (db.lastNotified && db.lastNotified[userId]) {
    delete db.lastNotified[userId];
    saveData(db);
    console.log('Cleared lastNotified for:', userId);
  }
  res.json({ ok: true });
});

// Test endpoint — send immediate notification to a user
app.post('/test-notify', async function(req, res) {
  var { userId } = req.body;
  var sub = db.subscriptions[userId];
  if (!sub) return res.status(404).json({ error: 'No subscription for ' + userId });
  var result = await sendPush(sub, '🐾 PawTraks Test!', 'Background notifications are working!', 'test');
  res.json({ result: result });
});

// Get VAPID public key (app needs this to subscribe)
app.get('/vapid-public-key', function(req, res) {
  res.json({ key: VAPID_PUBLIC });
});

// ── Notification scheduler (runs every 5 minutes) ───────
cron.schedule('*/5 * * * *', async function() {
  var now = Date.now();
  var userIds = Object.keys(db.schedules);
  console.log('[CRON] Running at ' + new Date().toISOString() + ' — ' + userIds.length + ' users, ' + Object.keys(db.subscriptions).length + ' subs');

  for (var i = 0; i < userIds.length; i++) {
    var userId = userIds[i];
    var sub = db.subscriptions[userId];
    if (!sub) continue;

    var schedule = db.schedules[userId];
    var dogs = schedule.dogs || [];
    // Track last notification times per user/dog
    if (!db.lastNotified) db.lastNotified = {};
    if (!db.lastNotified[userId]) db.lastNotified[userId] = {};
    var userNotified = db.lastNotified[userId];

    for (var j = 0; j < dogs.length; j++) {
      var dog = dogs[j];
      var age = parseFloat(dog.age) || 1;
      var name = dog.name;
      var feedCd = getFeedCooldown(age);
      var outCd  = getOutsideCooldown(age);

      var REPEAT_INTERVAL = 30 * 60000; // repeat reminder every 30 minutes if still not logged

      // Food reminder — fire when overdue, repeat every 30 min until logged
      var lastFed = dog.lastFed ? new Date(dog.lastFed).getTime() : 0;
      var lastFoodNotif = userNotified['food-' + dog.id] || 0;
      var foodOverdue = (now - lastFed) > feedCd;
      var foodNotifDue = lastFoodNotif === 0 || (now - lastFoodNotif) > REPEAT_INTERVAL;
      console.log('[CHECK] ' + name + ' food: overdue=' + foodOverdue + ' notifDue=' + foodNotifDue + ' lastFed=' + (lastFed ? new Date(lastFed).toISOString() : 'never') + ' feedCd=' + (feedCd/60000) + 'min');
      if (foodOverdue && foodNotifDue) {
        var result = await sendPush(sub,
          '🍽️ Time to feed ' + name + '!',
          name + ' is due for their next meal. Tap to log it in PawTraks.',
          'feed-' + dog.id
        );
        if (result === 'expired') { delete db.subscriptions[userId]; saveData(db); break; }
        if (result) { userNotified['food-' + dog.id] = now; }
      }

      // Water reminder — repeat every 30 min until logged
      var lastWater = dog.lastWater ? new Date(dog.lastWater).getTime() : 0;
      var lastWaterNotif = userNotified['water-' + dog.id] || 0;
      var waterOverdue = (now - lastWater) > feedCd;
      var waterNotifDue = lastWaterNotif === 0 || (now - lastWaterNotif) > REPEAT_INTERVAL;
      if (waterOverdue && waterNotifDue) {
        var wResult = await sendPush(sub,
          '💧 ' + name + ' needs water!',
          "Make sure " + name + "'s water bowl is fresh. Tap to log it in PawTraks.",
          'water-' + dog.id
        );
        if (wResult) { userNotified['water-' + dog.id] = now; }
      }

      // Outside reminder — repeat every 30 min until logged
      var lastOut = dog.lastOutside ? new Date(dog.lastOutside).getTime() : 0;
      var lastOutNotif = userNotified['outside-' + dog.id] || 0;
      var outOverdue = (now - lastOut) > outCd;
      var outNotifDue = lastOutNotif === 0 || (now - lastOutNotif) > REPEAT_INTERVAL;
      if (outOverdue && outNotifDue) {
        var oResult = await sendPush(sub,
          '🌳 ' + name + ' needs to go outside!',
          name + ' is due for an outdoor break. Tap to log it in PawTraks.',
          'outside-' + dog.id
        );
        if (oResult) { userNotified['outside-' + dog.id] = now; }
      }

      // Vet appointment reminders
      var appts = dog.vetAppointments || [];
      for (var k = 0; k < appts.length; k++) {
        var appt = appts[k];
        if (!appt.date) continue;
        var apptMs = new Date(appt.date).getTime();
        var hoursUntil = (apptMs - now) / 3600000;
        var vetKey = 'vet-' + appt.id;
        var lastVetNotif = userNotified[vetKey] || 0;
        var vetNotifDue = (now - lastVetNotif) > 3600000; // max once per hour
        if (vetNotifDue && ((hoursUntil <= 24 && hoursUntil > 23) || (hoursUntil <= 2 && hoursUntil > 1))) {
          var when = hoursUntil > 3 ? 'tomorrow' : 'in about 2 hours';
          var vResult = await sendPush(sub,
            '🩺 Vet appointment ' + when + '!',
            name + ': ' + (appt.reason || 'Vet visit') + (appt.vet ? ' with ' + appt.vet : ''),
            vetKey
          );
          if (vResult) { userNotified[vetKey] = now; }
        }
      }
    }
    db.lastNotified[userId] = userNotified;
  }
  saveData(db);
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
