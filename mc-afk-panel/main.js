const { app, BrowserWindow, shell } = require('electron');
const { start } = require('./server');

if (!app.requestSingleInstanceLock()) app.quit();

let ctl = null;
let win = null;

app.whenReady().then(async () => {
  // Kayıtlı sunucular kullanıcı veri klasöründe saklanır (~/.config/MC AFK Panel)
  ctl = await start({ port: 3000, dataDir: app.getPath('userData') });

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121214',
    title: 'Minecraft AFK Panel',
  });
  win.setMenuBarVisibility(false);
  // "Web'de aç" butonu yeni pencere açar -> sistem tarayıcısında açılsın
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${ctl.port}`);
});

app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => ctl && ctl.shutdown());
