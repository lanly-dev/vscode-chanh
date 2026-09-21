# Chanh 🍋
A VS Code extension that downloads, hosts, and runs the [Lemonade Server](https://lemonade-server.ai/) embeddable binary (`lemond`) locally, enabling AI chat with local LLMs directly in VS Code.
<a href="https://marketplace.visualstudio.com/items?itemName=	lanly-dev.chanh" target="_blank">
  <img src='https://code.visualstudio.com/favicon.ico' width='10'/>
</a>
<a href="https://open-vsx.org/extension/lanly-dev/chanh" target="_blank">
  <img src='https://open-vsx.org/favicon.ico' width='10'/>
</a>

> ⚠️ **Early stage**: The 0.0.1 release focuses primarily on setup: downloading and hosting the binary, plus basic server and model management.
> More functionality is planned for upcoming releases.
> Testing is still limited, and development has so far been done only on Windows.
> Other platforms and edge cases may not work as expected. Feedback and issue reports are welcome.

## Features
- Managing/downloading lemonade models
- Chatting integration

<img src='https://github.com/lanly-dev/vscode-chanh/blob/main/media/treeview.png?raw=true' width='450'/>

## Chat Commands
The `@chanh` chat participant supports the following slash commands:

- `/fix` - Generate a fix for the selected code
- `/explain` - Explain the selected code

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| `chanh.chatModel` | `""` | Model to use for chat (leave empty to be prompted) |
| `chanh.customServerUrl` | (unset) | Custom Lemonade Server URL used when `chanh.targetServer` is `"CUSTOM"` (e.g., http://localhost:13305) |
| `chanh.lemondPort` | `8000` | Port for the bundled lemond server (Managed by Chanh) |
| `chanh.maxLoadedModels` | (unset) | Maximum number of loaded models. Use `-1` for unlimited. |
| `chanh.lemonadePort` | `13305` | Port for the Lemonade Server (System) |
| `chanh.targetServer` | `"LEMONADE"` | Which Lemonade Server to use: `LEMONADE`, `LEMOND`, or `CUSTOM` |

## Server Mode Selection
You can choose which Lemonade server the extension uses by setting **`chanh.targetServer`** (`Chanh: Select Server` lets you pick from the command palette, which updates this setting automatically):

| Value | Behavior |
|-------|----------|
| `LEMONADE` (default) | Connects to an existing system install (`lemonade` CLI / Lemonade Server, port `chanh.lemonadePort`); extension only connects. |
| `LEMOND` | Runs the bundled `lemond` binary in globalStorage (port `chanh.lemondPort`); extension manages lifecycle. |
| `CUSTOM` | Connects to the URL in `chanh.customServerUrl`. |

## Release Notes

### 0.0.2
- Add icon

### 0.0.1
- Lemonade management treeview
- Chat integration

**Enjoy!**
