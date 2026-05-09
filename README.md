# Resource Monitor Lite

A small code-server and VS Code extension that shows CPU, memory, and disk usage without a build step.

## Features

- Status bar resource summary
- Webview dashboard for CPU, memory, disk, load average, uptime, and extension process memory
- Configurable refresh interval
- Configurable disk path

## Try it in code-server

Build the VSIX:

```bash
npm run package
```

Install it:

```bash
code-server --install-extension dist/resource-monitor-lite-0.0.1.vsix
```

Then reload code-server and run:

```text
Resource Monitor Lite: Show Dashboard
```

## Settings

- `resourceMonitorLite.refreshIntervalMs`
- `resourceMonitorLite.diskPath`
- `resourceMonitorLite.showDiskInStatusBar`
- `resourceMonitorLite.statusBarFormat`

## Development

This extension is intentionally plain JavaScript. The entry point is `extension.js`, so it can be loaded by code-server without TypeScript compilation.

Useful commands:

```bash
npm run check
npm run package
```
