# Change Log
All notable changes to the "Chanh" extension will be documented in this file.\
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [TODO]
- Agent benchmarking
- Agent integration via URL only
- Chat follow up
- Explore and add functionality for different types of models, e.g. image
- Focus on coding-related features
- GPU stats
- Token stats

## [0.1.2] - 2026-10-06
- Token counting uses the server tokenizer (`POST /v1/tokenize`), memoised; char estimate is the fallback (`ee90799`)
- Parallel tool calls split by `index`; indexless deltas split on new call ID, not merged (`7dc969f`)
- Unparseable tool-call arguments are dropped and logged; an empty turn fails with an explanatory error (`09937ae`)
- Each turn is capped by `max_tokens` (half window, 256-4096) instead of filling the whole window (`f00a788`)
- Truncated (`finish_reason: 'length'`) turns: rejected when empty, warned otherwise (`bd70441`)
- `maxInputTokens`/`maxOutputTokens` split one window instead of each claiming the whole window (`966d95d`, `64927e1`)
- Agent picker matches labels case-insensitively; `llm` counts as chat (`966d95d`)
- Multi-tool `Required` forwards `tool_choice: 'required'`; unmet ones are logged with the request shape (`92672be`)
- A turn that thinks yet delivers nothing disables thinking for that model; no setting (`4cb046e`)
- 19 files, 71.89 KB, 1.140.0
```
chanh-0.1.2.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [6.04 KB]
   ├─ package.json [12.93 KB]
   ├─ readme.md [3.21 KB]
   ├─ dist/
   │  └─ extension.js [84.39 KB]
   └─ media/
      ├─ chanh.png [31.65 KB]
      ├─ chanh.svg [3.83 KB]
      └─ capabilities/
         ├─ 3d.svg [0.36 KB]
         ├─ classification.svg [0.4 KB]
         ├─ embedding.svg [0.45 KB]
         ├─ hot.svg [0.44 KB]
         ├─ image.svg [0.33 KB]
         ├─ llm.svg [0.46 KB]
         ├─ reranking.svg [0.3 KB]
         ├─ tool-calling.svg [0.29 KB]
         ├─ transcription.svg [0.3 KB]
         └─ tts.svg [0.29 KB]
```
### Notes
- After improving agent integration, an eval/test/benchmarking suite is needed to tell whether it actually improved

## [0.1.1] - 2026-09-27
- Adds backends/recipes management
- `Show Model Info` inline button on downloadable model rows, same as the installed/loaded rows
- Treeview now repaints when agent mode loads a model on demand, showing the request lifecycle (`idle` / `busy` / `streaming`)
- Models reload when the backend changes
- 19 files, 69.75 KB, 1.138.0

```
chanh-0.1.1.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [4.05 KB]
   ├─ package.json [12.93 KB]
   ├─ readme.md [3.07 KB]
   ├─ dist/
   │  └─ extension.js [80.3 KB]
   └─ media/
      ├─ chanh.png [31.65 KB]
      ├─ chanh.svg [3.83 KB]
      └─ capabilities/
         ├─ 3d.svg [0.36 KB]
         ├─ classification.svg [0.4 KB]
         ├─ embedding.svg [0.45 KB]
         ├─ hot.svg [0.44 KB]
         ├─ image.svg [0.33 KB]
         ├─ llm.svg [0.46 KB]
         ├─ reranking.svg [0.3 KB]
         ├─ tool-calling.svg [0.29 KB]
         ├─ transcription.svg [0.3 KB]
         └─ tts.svg [0.29 KB]
```

## [0.1.0] - 2026-09-21
### Renamed
- Extension renamed from *Lemon* to *Chanh*, plus the icon change
- Server modes renamed: `LEMONADE` (system install), `LEMOND` (binary), `CUSTOM`
- Settings renamed: `chanh.serverMode` (was `chanh.targetServer`), `chanh.lemonadePort`, `chanh.lemondPort`

### Added
- Language Model API integration: models exposed to the native VS Code model picker (`chanh` provider) for agent-mode usage
- Model capability labels (llm, embedding, reranking, transcription, tts, image, 3d) in the tree view
- Custom server mode: URL validation on switch; unreachable error shown as subtext/description on the status row
- Treeview inline buttons
- Binary update check throttled to once per day
- 19 files, 66.21 KB, 1.138.0
```
chanh-0.1.0.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [2.96 KB]
   ├─ package.json [11.94 KB]
   ├─ readme.md [3.03 KB]
   ├─ dist/
   │  └─ extension.js [69.09 KB]
   └─ media/
      ├─ chanh.png [31.65 KB]
      ├─ chanh.svg [3.83 KB]
      └─ capabilities/
         ├─ 3d.svg [0.36 KB]
         ├─ classification.svg [0.4 KB]
         ├─ embedding.svg [0.45 KB]
         ├─ hot.svg [0.44 KB]
         ├─ image.svg [0.33 KB]
         ├─ llm.svg [0.46 KB]
         ├─ reranking.svg [0.3 KB]
         ├─ tool-calling.svg [0.29 KB]
         ├─ transcription.svg [0.3 KB]
         └─ tts.svg [0.29 KB]
```
### Notes
- Timeout policy per path: 15s one-shot calls, 10 min model loads, 120s silence watchdog + cancellation for chat streams

### Reference
- https://marketplace.visualstudio.com/items?itemName=lemonade-sdk.lemonade-sdk
- https://marketplace.visualstudio.com/items?itemName=JamesMartinez.lemonade-dashboard

## [0.0.1, 0.0.2] - 2026-09-02
- Initial release
- Focused on managing models through treeview
- Chat integration with chat models
- 9 files, 46.88 KB, 1.136, req1.134

```
lemon-0.0.2.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [1.04 KB]
   ├─ package.json [8.53 KB]
   ├─ readme.md [2.53 KB]
   ├─ dist/
   │  └─ extension.js [46.96 KB]
   └─ media/
      ├─ lemon.png [25.9 KB]
      └─ lemon.svg [0.94 KB]
```

### Notes
- `name` and `displayName` need to be unique in the VS Code marketplace

### Reference
- https://lemonade-server.ai
- https://code.visualstudio.com/api/references/extension-manifest
