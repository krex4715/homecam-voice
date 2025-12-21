// electron/main.cjs
const { app, BrowserWindow, session } = require("electron");
const path = require("path");

// 자동재생(오디오) 사용자 제스처 요구 완화
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function setupPermissions() {
  const ses = session.defaultSession;

  // ✅ 권한 요청(카메라/마이크) 자동 허용
  ses.setPermissionRequestHandler((webContents, permission, callback /*, details */) => {
    if (permission === "media") return callback(true);
    return callback(false);
  });

  // ✅ 권한 체크도 media는 통과시키기(일부 환경에서 도움이 됨)
  ses.setPermissionCheckHandler((webContents, permission /*, requestingOrigin, details */) => {
    if (permission === "media") return true;
    return false;
  });
}

function createWindow() {
  setupPermissions();

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    kiosk: true, // 원치 않으면 false
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,

      // ✅ 포커스/상태 변화 때 오디오/타이밍 스로틀링으로
      // 마이크 처리/AudioContext가 불안정해지는 케이스 방지
      backgroundThrottling: false,
    },
  });

  if (app.isPackaged) {
    // packaged: dist/index.html 로드
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    // dev: vite dev server 로드
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  // macOS 대응(필요 시)
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
