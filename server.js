const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Init Firebase Admin
var serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch(e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e.message);
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
var firestore = getFirestore();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BDog6Dq3O44SgyVZhKYL2ypqykH02_BBLdYEIAZiuhCQbcVdWWm-t6dkQirES-SgzUK06lQVyvidyC9p7tGVNeU';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'lv5NXDWuxy8RfCsuZUVJGfZ7T8AV1gPcD-pHhL7daas';
const VAPID_EMAIL   = process.env.VAPID_EMAIL   || 'mailto:pawtraks@master.com';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

var DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
var DATA_FILE = path.join(DATA_DIR, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { subscriptions: {} };
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d)); } catch(e) {}
}

var db = loadData();

async function sendPush(sub, title, body, tag) {
  try {
    await webpush.sendNotification(sub, JSON.stringify({
      title, body,
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag,
      data: { url: '/' }
    }));
    console.log('[PUSH] Sent:', tag);
    return true;
  } catch(e) {
    if (e.statusCode === 410) return 'expired';
    console.log('[PUSH] Error:', e.statusCode, e.message);
    return false;
  }
}

// Cooldown helpers (mirrors App.js logic)
function getFedCooldown(dog) {
  var size = (dog.weight || 20) < 20 ? 'small' : (dog.weight || 20) < 50 ? 'medium' : 'large';
  return size === 'small' ? 8*3600000 : size === 'medium' ? 10*3600000 : 12*3600000;
}
function getWaterCooldown() { return 4*3600000; }
function getOutsideCooldown(dog) {
  var size = (dog.weight || 20) < 20 ? 'small' : (dog.weight || 20) < 50 ? 'medium' : 'large';
  return size === 'small' ? 2*3600000 : size === 'medium' ? 3*3600000 : 4*3600000;
}

// Pull all users from Firebase and build schedules on the server
async function buildSchedulesFromFirebase() {
  try {
    var snap = await firestore.collection('users').get();
    var schedules = {};
    var now = Date.now();

    snap.forEach(function(docSnap) {
      var userData = docSnap.data();
      if (!userData || !userData.email) return;
      if (userData.deleted) return;

      var dogs = userData.dogs || [];
      if (!dogs.length) return;

      var userId = userData.email;
      var entries = [];

      dogs.forEach(function(dog) {
        var name = dog.name || 'Your dog';

        // Feed
        var lastFed = dog.lastFed ? new Date(dog.lastFed).getTime() : 0;
        var feedDue = lastFed ? lastFed + getFedCooldown(dog) : now;
        if (feedDue > now) {
          entries.push({ dueAt: feedDue, title: '🍽️ ' + name + ' needs to be fed!', body: 'Time to feed ' + name + '.', fired: false });
        }

        // Water
        var lastWater = dog.lastWater ? new Date(dog.lastWater).getTime() : 0;
        var waterDue = lastWater ? lastWater + getWaterCooldown() : now;
        if (waterDue > now) {
          entries.push({ dueAt: waterDue, title: '💧 ' + name + ' needs water!', body: "Time to refresh " + name + "'s water bowl.", fired: false });
        }

        // Outside
        var lastOutside = dog.lastOutside ? new Date(dog.lastOutside).getTime() : 0;
        var outsideDue = lastOutside ? lastOutside + getOutsideCooldown(dog) : now;
        if (outsideDue > now) {
          entries.push({ dueAt: outsideDue, title: '🌳 ' + name + ' needs to go outside!', body: 'Time to take ' + name + ' for a walk.', fired: false });
        }
      });

      if (entries.length) schedules[userId] = entries;
    });

    console.log('[FIREBASE] Built schedules for', Object.keys(schedules).length, 'users');
    return schedules;
  } catch(e) {
    console.log('[FIREBASE] Error reading users:', e.message);
    return {};
  }
}

app.get('/', function(req, res) {
  res.json({
    status: 'PawTraks push server running',
    subs: Object.keys(db.subscriptions).length
  });
});

app.post('/subscribe', function(req, res) {
  var { userId, subscription } = req.body;
  if (!userId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing userId or subscription' });
  }
  db.subscriptions[userId] = subscription;
  saveData(db);
  console.log('[SUB] Saved for:', userId);
  res.json({ ok: true });
});

app.post('/schedule', function(req, res) {
  // App still sends schedules — we accept but ignore since server now reads Firebase directly
  res.json({ ok: true });
});

app.post('/unsubscribe', function(req, res) {
  var { userId } = req.body;
  if (userId) {
    delete db.subscriptions[userId];
    saveData(db);
    console.log('[UNSUB] Removed:', userId);
  }
  res.json({ ok: true });
});

app.get('/subscribers', function(req, res) {
  res.json({
    count: Object.keys(db.subscriptions).length,
    users: Object.keys(db.subscriptions)
  });
});

app.post('/test-notify', async function(req, res) {
  var { userId } = req.body;
  var sub = db.subscriptions[userId];
  if (!sub) return res.status(404).json({ error: 'No subscription for ' + userId });
  var result = await sendPush(sub, '🐾 PawTraks Test!', 'Background notifications are working!', 'test');
  res.json({ result });
});

app.get('/vapid-public-key', function(req, res) {
  res.json({ key: VAPID_PUBLIC });
});

// Cron: every 5 minutes — pull from Firebase, fire due notifications
cron.schedule('*/5 * * * *', async function() {
  var now = Date.now();
  console.log('[CRON]', new Date().toISOString(), '— checking Firebase for due notifications');

  var schedules = await buildSchedulesFromFirebase();
  if (!db.reminders) db.reminders = {};

  var userIds = Object.keys(schedules);
  var changed = false;

  for (var i = 0; i < userIds.length; i++) {
    var userId = userIds[i];
    var sub = db.subscriptions[userId];
    if (!sub) continue;

    if (!db.reminders[userId]) db.reminders[userId] = {};
    var userReminders = db.reminders[userId];

    var entries = schedules[userId];

    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (now < entry.dueAt) continue;

      var key = entry.title; // unique per action type + dog name
      if (!userReminders[key]) userReminders[key] = { count: 0, lastFired: 0, firstDueAt: entry.dueAt };

      var reminder = userReminders[key];

      // If the action was logged since we started reminding, reset
      if (entry.dueAt > reminder.firstDueAt) {
        userReminders[key] = { count: 0, lastFired: 0, firstDueAt: entry.dueAt };
        reminder = userReminders[key];
      }

      // Stop after 3 reminders
      if (reminder.count >= 3) continue;

      // First reminder — fire immediately when due
      if (reminder.count === 0) {
        var result = await sendPush(sub, entry.title, entry.body, key + '-1');
        if (result === 'expired') { delete db.subscriptions[userId]; changed = true; break; }
        if (result) { reminder.count = 1; reminder.lastFired = now; changed = true; }
      }

      // Second reminder — 1.5 hours after first
      else if (reminder.count === 1 && now >= reminder.lastFired + 90 * 60 * 1000) {
        var result = await sendPush(sub, entry.title, '⏰ Reminder: ' + entry.body, key + '-2');
        if (result === 'expired') { delete db.subscriptions[userId]; changed = true; break; }
        if (result) { reminder.count = 2; reminder.lastFired = now; changed = true; }
      }

      // Third reminder — 2 hours after second
      else if (reminder.count === 2 && now >= reminder.lastFired + 120 * 60 * 1000) {
        var result = await sendPush(sub, entry.title, '🔔 Final reminder: ' + entry.body, key + '-3');
        if (result === 'expired') { delete db.subscriptions[userId]; changed = true; break; }
        if (result) { reminder.count = 3; reminder.lastFired = now; changed = true; }
      }
    }

    db.reminders[userId] = userReminders;
  }

  if (changed) saveData(db);
});

// Also install firebase-admin on startup check
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('PawTraks push server running on port', PORT);
});