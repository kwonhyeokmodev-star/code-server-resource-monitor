"use strict";

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");

const DEFAULT_INTERVAL_MS = 1000;
const PLATFORM = os.platform();
const CPU_INFO = createCpuInfo();
const sampleMemory = createMemorySampler(PLATFORM);

// code-server 상태바와 대시보드를 함께 관리하는 확장 본체입니다.
class ResourceMonitor {
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.timer = undefined;
    this.previousCpuSample = sampleCpu();
    this.lastStats = undefined;
    this.disposables = [];

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "resourceMonitorLite.showDashboard";
    this.statusBar.tooltip = "Open Resource Monitor Lite";
    this.statusBar.text = "$(pulse) Resource monitor starting...";
    this.statusBar.show();

    this.disposables.push(this.statusBar);
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("resourceMonitorLite")) {
        this.restart();
      }
    }));
  }

  start() {
    // 시작 직후 한 번 갱신하고, 이후에는 설정된 주기로 반복 갱신합니다.
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs());
  }

  restart() {
    this.stopTimer();
    this.start();
  }

  dispose() {
    this.stopTimer();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  intervalMs() {
    const configured = getConfig().get("refreshIntervalMs", DEFAULT_INTERVAL_MS);
    return Math.max(500, Number(configured) || DEFAULT_INTERVAL_MS);
  }

  async refresh() {
    try {
      // CPU 사용률은 이전 샘플과 현재 샘플의 차이로 계산해야 순간값이 안정적으로 나옵니다.
      const stats = await collectStats(this.previousCpuSample);
      this.previousCpuSample = stats.cpu.sample;
      this.lastStats = stats;
      this.updateStatusBar(stats);
      this.postStats(stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusBar.text = "$(warning) Resource monitor error";
      this.statusBar.tooltip = message;
      this.postError(message);
    }
  }

  showDashboard() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postStats(this.lastStats);
      return;
    }

    // Webview는 VS Code/code-server 안에서 별도 HTML 화면으로 대시보드를 보여줍니다.
    this.panel = vscode.window.createWebviewPanel(
      "resourceMonitorLite",
      "Resource Monitor Lite",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderDashboardHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, undefined, this.context.subscriptions);

    this.postStats(this.lastStats);
  }

  updateStatusBar(stats) {
    const config = getConfig();
    const format = config.get("statusBarFormat", "$(pulse) CPU {cpu}%  MEM {mem}%");

    // 사용자가 설정에서 상태바 문구를 바꿀 수 있도록 플레이스홀더를 치환합니다.
    this.statusBar.text = format
      .replaceAll("{cpu}", formatPercent(stats.cpu.percent))
      .replaceAll("{mem}", formatPercent(stats.memory.percent))
      .replaceAll("{load1}", stats.loadAverage[0].toFixed(2))
      .replaceAll("{usedMem}", formatBytes(stats.memory.used))
      .replaceAll("{totalMem}", formatBytes(stats.memory.total));

    this.statusBar.tooltip = [
      `CPU ${formatPercent(stats.cpu.percent)}%`,
      `Memory ${formatPercent(stats.memory.percent)}% (${formatBytes(stats.memory.used)} used / ${formatBytes(stats.memory.free)} available, ${stats.memory.source})`,
      `Load ${stats.loadAverage.map((value) => value.toFixed(2)).join(", ")}`
    ].join("\n");
  }

  postStats(stats) {
    if (!this.panel || !stats) {
      return;
    }

    this.panel.webview.postMessage({ type: "stats", stats });
  }

  postError(message) {
    if (!this.panel) {
      return;
    }

    this.panel.webview.postMessage({ type: "error", message });
  }
}

async function collectStats(previousCpuSample) {
  // code-server 서버 프로세스가 보는 리소스를 측정합니다.
  const cpuSample = sampleCpu();
  const cpuPercent = calculateCpuPercent(previousCpuSample, cpuSample);
  const memory = sampleMemory();

  return {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptime: os.uptime(),
    cpu: {
      percent: cpuPercent,
      cores: CPU_INFO.cores,
      model: CPU_INFO.model,
      sample: cpuSample
    },
    memory,
    loadAverage: os.loadavg(),
    process: {
      pid: process.pid,
      memory: process.memoryUsage()
    }
  };
}

function sampleCpu() {
  // 전체 코어의 idle/total 시간을 합산해 다음 샘플과 비교할 기준값을 만듭니다.
  return os.cpus().reduce((accumulator, cpu) => {
    const idle = cpu.times.idle;
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: accumulator.idle + idle,
      total: accumulator.total + total
    };
  }, { idle: 0, total: 0 });
}

function createCpuInfo() {
  const cpus = os.cpus();

  return {
    cores: cpus.length,
    model: cpus[0] ? cpus[0].model : "Unknown CPU"
  };
}

function calculateCpuPercent(previous, current) {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (totalDelta <= 0) {
    return 0;
  }

  // 전체 시간 증가분에서 idle 증가분을 뺀 값이 실제로 사용된 CPU 시간입니다.
  return clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100);
}

function createMemorySampler(platform) {
  if (platform === "linux") {
    const linuxTotal = readLinuxMemTotal();

    if (linuxTotal) {
      return () => sampleLinuxMemoryWithFallback(linuxTotal);
    }
  }

  const fallbackTotal = os.totalmem();
  return () => sampleFallbackMemory(fallbackTotal);
}

function sampleLinuxMemoryWithFallback(total) {
  const linuxMemory = sampleLinuxMemory(total);

  if (linuxMemory) {
    return linuxMemory;
  }

  return sampleFallbackMemory(total);
}

function sampleFallbackMemory(total) {
  // Linux meminfo를 읽지 못하거나 Linux가 아니면 Node의 기본 freemem 값을 사용합니다.
  const free = os.freemem();
  const used = total - free;

  return {
    total,
    free,
    used,
    percent: total > 0 ? clamp((used / total) * 100, 0, 100) : 0,
    source: "os.freemem"
  };
}

function readLinuxMemTotal() {
  try {
    const meminfo = parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8"));
    return meminfo.MemTotal;
  } catch {
    return undefined;
  }
}

function sampleLinuxMemory(total) {
  try {
    // Linux에서는 매초 바뀌는 MemAvailable만 읽고, MemTotal은 시작 시점에 잡은 값을 재사용합니다.
    const meminfo = parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8"));
    const available = meminfo.MemAvailable;

    if (!available) {
      return undefined;
    }

    const used = total - available;

    return {
      total,
      free: available,
      used,
      percent: clamp((used / total) * 100, 0, 100),
      source: "MemAvailable"
    };
  } catch {
    return undefined;
  }
}

function parseMeminfo(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);

    if (match) {
      values[match[1]] = Number(match[2]) * 1024;
    }
  }

  return values;
}

function renderDashboardHtml(webview) {
  const nonce = createNonce();
  // Webview 보안을 위해 현재 nonce가 붙은 스크립트만 실행되도록 제한합니다.
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resource Monitor Lite</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-progressBar-background);
      --warning: var(--vscode-editorWarning-foreground);
      --danger: var(--vscode-editorError-foreground);
      --card: var(--vscode-sideBar-background);
      --mono: var(--vscode-editor-font-family);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 24px;
      color: var(--fg);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    main {
      max-width: 1040px;
      margin: 0 auto;
    }

    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 14px;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
    }

    .timestamp {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }

    .card {
      min-height: 156px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--card);
    }

    .label {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    .value {
      margin: 14px 0 10px;
      font-size: 34px;
      font-weight: 650;
      line-height: 1;
    }

    .meter {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--vscode-input-background);
    }

    .bar {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
      transition: width 180ms ease;
    }

    .bar.warning {
      background: var(--warning);
    }

    .bar.danger {
      background: var(--danger);
    }

    .detail {
      margin-top: 12px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }

    .wide {
      grid-column: 1 / -1;
      min-height: 0;
    }

    dl {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px 18px;
      margin: 0;
    }

    dt {
      color: var(--muted);
      font-size: 12px;
    }

    dd {
      margin: 4px 0 0;
      font-family: var(--mono);
      word-break: break-word;
    }

    .error {
      display: none;
      margin-bottom: 12px;
      padding: 10px 12px;
      border-left: 3px solid var(--danger);
      background: var(--vscode-inputValidation-errorBackground);
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Resource Monitor Lite</h1>
      <div class="timestamp" id="timestamp">Waiting for data...</div>
    </header>
    <div class="error" id="error"></div>
    <section class="grid">
      <article class="card">
        <div class="label"><span>CPU</span><span id="cpuCores">-</span></div>
        <div class="value" id="cpuValue">--%</div>
        <div class="meter"><div class="bar" id="cpuBar"></div></div>
        <div class="detail" id="cpuDetail">-</div>
      </article>
      <article class="card">
        <div class="label"><span>Memory</span><span id="memoryTotal">-</span></div>
        <div class="value" id="memoryValue">--%</div>
        <div class="meter"><div class="bar" id="memoryBar"></div></div>
        <div class="detail" id="memoryDetail">-</div>
      </article>
      <article class="card wide">
        <dl>
          <div>
            <dt>Host</dt>
            <dd id="host">-</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd id="platform">-</dd>
          </div>
          <div>
            <dt>Load Average</dt>
            <dd id="load">-</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd id="uptime">-</dd>
          </div>
          <div>
            <dt>Extension Process</dt>
            <dd id="process">-</dd>
          </div>
        </dl>
      </article>
    </section>
  </main>
  <script nonce="${nonce}">
    const byId = (id) => document.getElementById(id);

    window.addEventListener("message", (event) => {
      const message = event.data;

      if (message.type === "error") {
        const error = byId("error");
        error.textContent = message.message;
        error.style.display = "block";
        return;
      }

      if (message.type !== "stats") {
        return;
      }

      byId("error").style.display = "none";
      render(message.stats);
    });

    function render(stats) {
      byId("timestamp").textContent = new Date(stats.timestamp).toLocaleString();
      setMeter("cpu", stats.cpu.percent);
      setMeter("memory", stats.memory.percent);

      byId("cpuCores").textContent = stats.cpu.cores + " cores";
      byId("cpuDetail").textContent = stats.cpu.model;
      byId("memoryTotal").textContent = bytes(stats.memory.total);
      byId("memoryDetail").textContent = bytes(stats.memory.used) + " used / " + bytes(stats.memory.free) + " available (" + stats.memory.source + ")";

      byId("host").textContent = stats.hostname;
      byId("platform").textContent = stats.platform;
      byId("load").textContent = stats.loadAverage.map((value) => value.toFixed(2)).join(", ");
      byId("uptime").textContent = duration(stats.uptime);
      byId("process").textContent = "PID " + stats.process.pid + ", RSS " + bytes(stats.process.memory.rss);
    }

    function setMeter(prefix, value) {
      const rounded = Math.round(value);
      const bar = byId(prefix + "Bar");
      byId(prefix + "Value").textContent = rounded + "%";
      bar.style.width = Math.max(0, Math.min(100, value)) + "%";
      bar.classList.toggle("warning", value >= 70 && value < 90);
      bar.classList.toggle("danger", value >= 90);
    }

    function bytes(value) {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = Number(value) || 0;
      let index = 0;

      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }

      return size.toFixed(index === 0 ? 0 : 1) + " " + units[index];
    }

    function duration(totalSeconds) {
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      return days + "d " + hours + "h " + minutes + "m";
    }
  </script>
</body>
</html>`;
}

function getConfig() {
  return vscode.workspace.getConfiguration("resourceMonitorLite");
}

function formatPercent(value) {
  return Math.round(Number(value) || 0);
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value) || 0;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";

  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}

function activate(context) {
  // 확장이 활성화되면 모니터를 만들고 명령 팔레트용 명령을 등록합니다.
  const monitor = new ResourceMonitor(context);

  context.subscriptions.push(monitor);
  context.subscriptions.push(vscode.commands.registerCommand("resourceMonitorLite.showDashboard", () => {
    monitor.showDashboard();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("resourceMonitorLite.refresh", () => {
    monitor.refresh();
  }));

  monitor.start();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
