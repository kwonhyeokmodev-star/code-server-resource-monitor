"use strict";

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

const DEFAULT_INTERVAL_MS = 2000;

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
    const showDisk = config.get("showDiskInStatusBar", true);
    let format = config.get("statusBarFormat", "$(pulse) CPU {cpu}%  MEM {mem}%  DISK {disk}%");

    if (!showDisk) {
      format = format.replace(/\s*DISK\s+\{disk\}%/i, "");
    }

    this.statusBar.text = format
      .replaceAll("{cpu}", formatPercent(stats.cpu.percent))
      .replaceAll("{mem}", formatPercent(stats.memory.percent))
      .replaceAll("{disk}", stats.disk ? formatPercent(stats.disk.percent) : "n/a")
      .replaceAll("{load1}", stats.loadAverage[0].toFixed(2))
      .replaceAll("{usedMem}", formatBytes(stats.memory.used))
      .replaceAll("{totalMem}", formatBytes(stats.memory.total))
      .replaceAll("{diskPath}", stats.diskPath);

    const diskLine = stats.disk
      ? `Disk ${formatPercent(stats.disk.percent)}% (${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)})`
      : `Disk unavailable for ${stats.diskPath}`;

    this.statusBar.tooltip = [
      `CPU ${formatPercent(stats.cpu.percent)}%`,
      `Memory ${formatPercent(stats.memory.percent)}% (${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)})`,
      diskLine,
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
  const diskPath = getConfig().get("diskPath", "/") || "/";
  const cpuSample = sampleCpu();
  const cpuPercent = calculateCpuPercent(previousCpuSample, cpuSample);
  const memory = sampleMemory();
  const disk = await sampleDisk(diskPath);

  return {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptime: os.uptime(),
    cpu: {
      percent: cpuPercent,
      cores: os.cpus().length,
      model: os.cpus()[0] ? os.cpus()[0].model : "Unknown CPU",
      sample: cpuSample
    },
    memory,
    disk,
    diskPath,
    loadAverage: os.loadavg(),
    process: {
      pid: process.pid,
      memory: process.memoryUsage()
    }
  };
}

function sampleCpu() {
  return os.cpus().reduce((accumulator, cpu) => {
    const idle = cpu.times.idle;
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: accumulator.idle + idle,
      total: accumulator.total + total
    };
  }, { idle: 0, total: 0 });
}

function calculateCpuPercent(previous, current) {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (totalDelta <= 0) {
    return 0;
  }

  return clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100);
}

function sampleMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    total,
    free,
    used,
    percent: total > 0 ? clamp((used / total) * 100, 0, 100) : 0
  };
}

function sampleDisk(pathToCheck) {
  return new Promise((resolve) => {
    execFile("df", ["-Pk", pathToCheck], { timeout: 1500 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }

      const lines = stdout.trim().split(/\r?\n/);
      const line = lines[lines.length - 1];
      const parts = line ? line.split(/\s+/) : [];

      if (parts.length < 6) {
        resolve(undefined);
        return;
      }

      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      const available = Number(parts[3]) * 1024;
      const percent = Number(parts[4].replace("%", ""));
      const mount = parts.slice(5).join(" ");

      resolve({
        filesystem: parts[0],
        total,
        used,
        available,
        percent: Number.isFinite(percent) ? percent : total > 0 ? (used / total) * 100 : 0,
        mount
      });
    });
  });
}

function renderDashboardHtml(webview) {
  const nonce = createNonce();
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
      <article class="card">
        <div class="label"><span>Disk</span><span id="diskPath">-</span></div>
        <div class="value" id="diskValue">--%</div>
        <div class="meter"><div class="bar" id="diskBar"></div></div>
        <div class="detail" id="diskDetail">-</div>
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
      byId("memoryDetail").textContent = bytes(stats.memory.used) + " used / " + bytes(stats.memory.free) + " free";

      if (stats.disk) {
        setMeter("disk", stats.disk.percent);
        byId("diskPath").textContent = stats.diskPath;
        byId("diskDetail").textContent = bytes(stats.disk.used) + " used / " + bytes(stats.disk.available) + " available on " + stats.disk.mount;
      } else {
        byId("diskValue").textContent = "n/a";
        byId("diskBar").style.width = "0%";
        byId("diskDetail").textContent = "Disk usage is unavailable for " + stats.diskPath;
      }

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
