const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS
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

// Storage
var DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
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
// Migrate old format: remove any leftover dogs/lastNotified keys
if (db.lastNotified) { delete db.lastNotified; saveData(db); }

// Send a push notification
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', function(req, res) {
  res.json({
    status: 'PawTraks push server running',
    subs: Object.keys(db.subscriptions).length,
    scheduled: Object.keys(db.schedules).length
  });
});

// Save push subscription
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

// Save schedule — expects { userId, schedule: [{ dueAt, title, body }] }
// The app sends this every time an action is logged, so timestamps are always fresh.
app.post('/schedule', function(req, res) {
  var { userId, schedule } = req.body;

  // Support legacy format { dogs: [...] } — just ignore it gracefully
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (!Array.isArray(schedule)) {
    console.log('[SCHEDULE] Received legacy dogs format for', userId, '— ignoring, waiting for app update');
    return res.json({ ok: true, note: 'legacy format ignored' });
  }

  // Store entries with a "fired" flag so we only send each one once
  db.schedules[userId] = schedule.map(function(entry) {
    return {
      dueAt: entry.dueAt,
      title: entry.title,
      body:  entry.body,
      fired: false
    };
  });

  saveData(db);
  console.log('[SCHEDULE] Saved', schedule.length, 'entries for:', userId);
  res.json({ ok: true });
});

// Unsubscribe on logout
app.post('/unsubscribe', function(req, res) {
  var { userId } = req.body;
  if (userId) {
    delete db.subscriptions[userId];
    delete db.schedules[userId];
    saveData(db);
    console.log('[UNSUB] Removed:', userId);
  }
  res.json({ ok: true });
});

// Admin: list subscribers
app.get('/subscribers', function(req, res) {
  res.json({
    count: Object.keys(db.subscriptions).length,
    users: Object.keys(db.subscriptions),
    scheduled: Object.keys(db.schedules)
  });
});

// Test notification
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

// ── Cron: check every 5 minutes ───────────────────────────────────────────────
// Only fires a notification when:
//   1. The entry's dueAt timestamp has passed (now >= dueAt)
//   2. The entry has not already been fired (fired === false)
// When the user logs an action in the app, the app posts a fresh schedule with
// new dueAt timestamps, resetting the fired flags automatically.

cron.schedule('*/5 * * * *', async function() {
  var now = Date.now();
  var userIds = Object.keys(db.schedules);
  console.log('[CRON]', new Date().toISOString(), '—', userIds.length, 'users with schedules');

  var changed = false;

  for (var i = 0; i < userIds.length; i++) {
    var userId = userIds[i];
    var sub = db.subscriptions[userId];
    if (!sub) continue;

    var entries = db.schedules[userId];
    if (!Array.isArray(entries)) continue;

    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (entry.fired) continue;           // already sent — skip
      if (now < entry.dueAt) continue;     // not due yet — skip

      var result = await sendPush(sub, entry.title, entry.body, 'scheduled-' + j);

      if (result === 'expired') {
        // Subscription dead — clean it up and stop
        delete db.subscriptions[userId];
        changed = true;
        break;
      }

      if (result) {
        entry.fired = true;  // mark sent so we never fire this entry again
        changed = true;
        console.log('[CRON] Fired:', entry.title, 'for', userId);
      }
    }
  }

  if (changed) saveData(db);
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('PawTraks push server running on port', PORT);
});
