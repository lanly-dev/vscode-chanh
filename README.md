# Chanh 🍋
**Chanh** `/ch-ahn/` (*n.*) — lime or lemon in Vietnamese

A VS Code extension that downloads, hosts, and runs the [Lemonade Server](https://lemonade-server.ai/)[ embeddable binary](https://lemonade-server.ai/docs/embeddable/backends) locally, enabling AI chat with local LLMs directly in VS Code.
<a href="https://marketplace.visualstudio.com/items?itemName=	lanly-dev.chanh" target="_blank">
  <img src='https://code.visualstudio.com/favicon.ico' width='10'/>
</a>
<a href="https://open-vsx.org/extension/lanly-dev/chanh" target="_blank">
  <img src='https://open-vsx.org/favicon.ico' width='10'/>
</a>

## Features
- Managing/downloading Lemonade models
- Chat integration (`@chanh` chat participant + models exposed to the native VS Code model picker)
- Multiple server modes: system-installed Lemonade Server, Embeddable Lemonade, or custom URL
- Just another way to integrate into VS Code [🔗](https://lemonade-server.ai/docs/integrations/ai-toolkit)

<img src='https://github.com/lanly-dev/vscode-chanh/blob/main/media/treeview.png?raw=true' width='450'/>

## Chat Commands
The `@chanh` chat participant supports the following slash commands:

- `/fix` - Generate a fix for the selected code
- `/explain` - Explain the selected code

## Server Management
The tree view in the sidebar shows the active server, its status and its models. You can pick different server modes, such as using the system-installed Lemonade Server or downloading the binary version.

## Agent model setting
Models served by the active Lemonade Server are exposed to VS Code's native model picker (under the `Chanh 🍋` provider), so agent-mode features like Copilot Chat can use them. `chanh.chatModel` remembers the last model used for the `@chanh` chat participant (leave empty to be prompted).

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| `chanh.chatModel` | `null` | Model to use for chat (leave empty to be prompted) |
| `chanh.customServerUrl` | `null` | Custom Lemonade Server URL (used in `CUSTOM` mode) |
| `chanh.lemondPort` | `8000` | Port for the bundled `lemond` binary |
| `chanh.lemonadePort` | `13305` | Port for the Lemonade Server (System) |
| `chanh.serverMode` | `"LEMONADE"` | Which Lemonade Server to use: `LEMONADE`, `LEMOND`, or `CUSTOM` |
| `chanh.maxLoadedModels` | (unset) | Maximum number of loaded models. Use `-1` for unlimited. |

## Release Notes

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
