# Change Log
All notable changes to the "Chanh" extension will be documented in this file.\
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [TODO]
- Backend runtime management
- Chat follow up
- Explore and add functionality for different types of models, e.g. image
- Focus on coding-related features
- GPU stats
- Token stats

## [0.1.0] - 2026-09-21
### Renamed
- Extension renamed from Lemon to Chanh, also the icon change
- Server modes renamed: `LEMONADE` (system install), `LEMOND` (binary), `CUSTOM`
- Settings renamed: `chanh.serverMode` (was `chanh.targetServer`), `chanh.lemonadePort`, `chanh.lemondPort`

### Added
- Language Model API integration: models exposed to the native VS Code model picker (`chanh` provider) for agent-mode usage
- Model capability labels (llm, embedding, reranking, transcription, tts, image, 3d) in the tree view
- Custom server mode: URL validation on switch; unreachable error shown as subtext/description on the status row
- Treeview inline buttons
- Binary update check (to once per day)

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

### Reference
- https://lemonade-server.ai
- https://code.visualstudio.com/api/references/extension-manifest

### Notes
- `name` and `displayName` need to be unique in the VS Code marketplace
