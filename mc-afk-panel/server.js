const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');

const ACTIONS = ['jump', 'hit'];
const MAX_LOG = 200;

function listen(server, port, tries = 10) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && tries > 0) resolve(listen(server, port + 1, tries - 1));
      else reject(err);
    };
    const onListening = () => { server.off('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onListening);
    
    server.listen(port, '127.0.0.1');
  });
}

async function start({ port = 3000, dataDir = path.join(__dirname, 'data') } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'bots.json');

 
  let bots = [];
  try { bots = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ilk çalıştırma */ }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(bots, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

 
  const runtime = new Map();
  const rt = (id) => {
    if (!runtime.has(id)) {
      runtime.set(id, { bot: null, status: 'Kapalı', logs: [], startedAt: null, retry: 0, timers: [], afk: null, reconnect: null, lastAuth: 0 });
    }
    return runtime.get(id);
  };

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  app.use(express.static(path.join(__dirname, 'public')));

  const view = (b) => {
    const r = rt(b.id);
    return { id: b.id, host: b.host, port: b.port, username: b.username, actionType: b.actionType, enabled: b.enabled, status: r.status, uptime: r.startedAt ? Math.floor((Date.now() - r.startedAt) / 1000) : 0 };
  };
  const pushBot = (b) => io.emit('bot', view(b));

  const log = (b, text) => {
    const r = rt(b.id);
    const line = `[${new Date().toLocaleTimeString('tr-TR')}] ${text}`;
    r.logs.push(line);
    if (r.logs.length > MAX_LOG) r.logs.shift();
    console.log(`[${b.username}@${b.host}] ${text}`);
    io.emit('log', { id: b.id, line });
  };
  const setStatus = (b, status) => { rt(b.id).status = status; pushBot(b); };

  const cleanup = (r) => {
    clearInterval(r.afk); r.afk = null;
    clearTimeout(r.reconnect); r.reconnect = null;
    r.timers.forEach(clearTimeout); r.timers = [];
  };

  function connect(b) {
    const r = rt(b.id);
    if (r.bot || !b.enabled) return;
    setStatus(b, 'Bağlanıyor...');
    log(b, `${b.host}:${b.port} adresine bağlanılıyor...`);

    const bot = mineflayer.createBot({ host: b.host, port: b.port, username: b.username, version: false, checkTimeoutInterval: 30000, hideErrors: true });
    r.bot = bot;

    bot.once('login', () => {
      r.retry = 0;
      r.startedAt = Date.now();
      setStatus(b, 'Bağlandı');
      log(b, `${bot.username} sunucuya giriş yaptı.`);
    });

    bot.on('spawn', () => {
      log(b, 'Bot dünyada aktif.');
      clearInterval(r.afk);
      r.afk = setInterval(() => {
        if (!bot.entity) return;
        if (b.actionType === 'jump') {
          bot.look(bot.entity.yaw + 0.5, bot.entity.pitch, true);
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 300);
        } else {
          bot.look(bot.entity.yaw + 0.3, bot.entity.pitch, true);
          bot.swingArm('right');
        }
      }, 15000);
    });

   
    bot.on('messagestr', (message) => {
      if (!b.password || Date.now() - r.lastAuth < 5000) return;
      const m = message.toLowerCase();
      if (/\/register|kay[ıi]t ol/.test(m)) {
        r.lastAuth = Date.now();
        bot.chat(`/register ${b.password} ${b.password}`);
        log(b, 'Kayıt komutu gönderildi.');
      } else if (/\/login|giri[sş] yap/.test(m)) {
        r.lastAuth = Date.now();
        bot.chat(`/login ${b.password}`);
        log(b, 'Giriş komutu gönderildi.');
      }
    });

    bot.on('kicked', (reason) => {
      let text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      log(b, `Sunucudan atıldı: ${text.replace(/§[0-9a-fk-or]/g, '')}`);
    });
    bot.on('error', (err) => log(b, `Bağlantı hatası: ${err.message || err}`));

    bot.on('end', (reason) => {
      cleanup(r);
      r.bot = null;
      r.startedAt = null;
      if (!b.enabled) { setStatus(b, 'Kapalı'); return; }
      r.retry += 1;
      const wait = Math.min(15 * r.retry, 120); // 15sn, 30sn, ... en fazla 2dk
      setStatus(b, 'Yeniden bağlanıyor...');
      log(b, `Bağlantı kesildi (${reason}). ${wait} sn sonra tekrar denenecek.`);
      r.reconnect = setTimeout(() => connect(b), wait * 1000);
    });
  }

  function disconnect(b, label = 'Kapalı') {
    const r = rt(b.id);
    cleanup(r);
    const bot = r.bot;
    r.bot = null;
    r.startedAt = null;
    r.retry = 0;
    if (bot) {
      bot.removeAllListeners();
      bot.on('error', () => {});
      try { bot.quit(); } catch { /* yoksay */ }
      try { bot.end(); } catch { /* yoksay */ }
    }
    setStatus(b, label);
  }

  // ---- Arayüz iletişimi ----
  io.on('connection', (socket) => {
    socket.emit('state', {
      bots: bots.map(view),
      logs: Object.fromEntries(bots.map((b) => [b.id, rt(b.id).logs])),
    });

    socket.on('bot-add', (cfg = {}) => {
      const host = String(cfg.host || '').trim();
      const username = String(cfg.username || '').trim();
      if (!host || !/^\w{3,16}$/.test(username)) {
        socket.emit('error-msg', 'Sunucu adresi boş olamaz; karakter ismi 3-16 harf/rakam/_ olmalı.');
        return;
      }
      const b = {
        id: crypto.randomUUID().slice(0, 8),
        host,
        port: parseInt(cfg.port, 10) || 25565,
        username,
        password: String(cfg.password || ''),
        actionType: ACTIONS.includes(cfg.actionType) ? cfg.actionType : 'jump',
        enabled: true,
      };
      bots.push(b);
      save();
      pushBot(b);
      connect(b);
    });

    socket.on('bot-toggle', ({ id, enabled } = {}) => {
      const b = bots.find((x) => x.id === id);
      if (!b) return;
      b.enabled = !!enabled;
      save();
      if (b.enabled) { log(b, 'Açıldı.'); connect(b); }
      else { log(b, 'Kapatıldı.'); disconnect(b); }
    });

    socket.on('bot-remove', (id) => {
      const i = bots.findIndex((x) => x.id === id);
      if (i === -1) return;
      disconnect(bots[i]);
      bots.splice(i, 1);
      runtime.delete(id);
      save();
      io.emit('bot-removed', id);
    });
  });

  
  const tick = setInterval(() => {
    const uptimes = {};
    for (const b of bots) {
      const r = rt(b.id);
      if (r.startedAt) uptimes[b.id] = Math.floor((Date.now() - r.startedAt) / 1000);
    }
    io.emit('uptimes', uptimes);
  }, 1000);

  const actualPort = await listen(server, port);
  console.log(`[SUNUCU] AFK Panel aktif: http://127.0.0.1:${actualPort}`);

  
  bots.filter((b) => b.enabled).forEach((b, i) => setTimeout(() => connect(b), i * 1500));

  return {
    port: actualPort,
    shutdown() {
      clearInterval(tick);
      bots.forEach((b) => disconnect(b));
      io.close();
      server.close();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: 3000 });
  process.on('SIGINT', () => process.exit(0));
}
