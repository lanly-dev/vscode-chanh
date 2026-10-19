# Chanh 🍋
**Chanh** `/ch-ahn/` (*n.*) — lime or lemon in Vietnamese

A VS Code extension that downloads, hosts, and runs the [Lemonade Server](https://lemonade-server.ai/) [embeddable binary](https://lemonade-server.ai/docs/embeddable/backends) locally, enabling AI chat with local LLMs directly in VS Code.
<a href="https://marketplace.visualstudio.com/items?itemName=lanly-dev.chanh" target="_blank">
  <img src='https://code.visualstudio.com/favicon.ico' width='10'/>
</a>
<a href="https://open-vsx.org/extension/lanly-dev/chanh" target="_blank">
  <img src='https://open-vsx.org/favicon.ico' width='10'/>
</a>

## Features
- Managing/downloading Lemonade models
- Chat integration: `@chanh` chat participant for quick Q&A, plus chat models with tool-calling support in the native VS Code model picker (agent mode, streaming, and vision)
- Everything runs locally and works offline
- Multiple server modes: system-installed Lemonade Server, Embeddable Lemonade, or custom URL
- Just another way to [integrate with VS Code](https://lemonade-server.ai/docs/integrations/ai-toolkit)

<img src='https://github.com/lanly-dev/vscode-chanh/blob/main/media/sc.png?raw=true' width='600'/>

## Interactive mockup
A standalone, clickable prototype of the extension UI lives in [`mockup/index.html`](mockup/index.html). Open it directly in a browser — no build or server needed — and click **Play demo** for a guided tour of server management, model downloads, context/backend settings, chat and the native model picker. All data is simulated.

<img src='mockup/preview.png' width='720'/>

### Demo video
A 2-minute narrated walkthrough of the real extension UI is available at [`demo/Chanh-UI-Demo.mp4`](demo/Chanh-UI-Demo.mp4). It covers server management, the model tree, model actions, Model Info, context/backend selection, the command palette and settings.

## Chat Commands
The `@chanh` chat participant supports the following slash commands:

- `/fix` - Generate a fix for the selected code
- `/explain` - Explain the selected code

## Server Management
The tree view in the sidebar shows the active server, its status and its models. You can pick different server modes, such as using the system-installed Lemonade Server or downloading the binary version.

## Agent mode and the model picker
Models served by the active Lemonade Server are exposed to VS Code's native model picker under the `Chanh 🍋` provider. Only chat-capable models that also advertise `tool-calling` are listed, since agent mode relies on tool calling. `chat` and `llm` labels are treated the same, and label matching is case-insensitive. Vision models (`vision` label) are tagged in the picker and accept image attachments.

Plain chat models (no `tool-calling` label) remain available through the `@chanh` participant. `chanh.chatModel` remembers the last model used for `@chanh` (leave empty to be prompted).

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| `chanh.chatModel` | `null` | Model to use for chat (leave empty to be prompted) |
| `chanh.customServerUrl` | `null` | Custom Lemonade Server URL (used in `CUSTOM` mode) |
| `chanh.lemondPort` | `8000` | Port for the bundled `lemond` binary |
| `chanh.lemonadePort` | `13305` | Port for the Lemonade Server (System) |
| `chanh.serverMode` | `"LEMONADE"` | Which Lemonade Server to use: `LEMONADE`, `LEMOND`, or `CUSTOM` |
| `chanh.maxLoadedModels` | (unset) | Maximum number of loaded models. Use `-1` for unlimited. |
| `chanh.showTokenStats` | `false` | Show per-turn token stats in the chat/agent footer (from the model's `usage` block) |
| `chanh.systemSampleInterval` | `5` | Seconds between System group CPU/GPU/RAM samples |

## Release Notes

### 0.1.3
- Add an eye button to toggle Installed and Downloadable sections
- Add custom endpoint option - Chanh 🍋‍🟩
- Add omni, audio-gen treeview group
- Add sub-capabilities filter
- Add system utilization treeview display
- Add token count footer option

### 0.1.2
- Bugfixes and improved agent integration

### 0.1.1
- Add backends/recipes management

### 0.1.0
- Change the extension name from Lemon to Chanh
- Add download function into the treeview
- Label capabilities of the model
- Integrate into the VS Code agent harness

### 0.0.2
- Add icon

### 0.0.1
- Lemonade management treeview
- Chat integration

**Enjoy!**
