# Chanh website

Static landing page for the Chanh VS Code extension, including a YouTube-ready demo preview and the interactive UI mockup.

![Chanh website preview](preview.png)

## Preview locally

From the repository root:

```bash
python -m http.server 8000 --directory website
```

Then open <http://localhost:8000/>. A local server is recommended so directory links behave the same as on GitHub Pages.

## Deploy to GitHub Pages

The workflow at [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) publishes the `website/` folder as a Pages artifact.

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Run the **Deploy website** workflow, or push a change under `website/`.

The site will be available at:

```
https://<user>.github.io/<repository>/
```

For the current remote (`lemond`), that is **<https://lanly-dev.github.io/lemond/>**.

## YouTube demo

The 1:57 MP4 is intentionally **not committed**. The page shows the poster as a placeholder and says the video is coming to YouTube.

When the video is published:

1. Set the URL at the top of [`site.js`](site.js):

   ```js
   const YOUTUBE_URL = 'https://youtu.be/XXXXXXXXXXX'
   ```

2. Commit and push. Both "preview" play buttons now open YouTube, and the badges change to **Watch on YouTube**.

Inline playback is optional. If you prefer a YouTube embed instead of opening a new tab, replace the `.video-frame` contents in `index.html` with:

```html
<iframe
  class="youtube-embed"
  src="https://www.youtube-nocookie.com/embed/XXXXXXXXXXX"
  title="Chanh UI walkthrough"
  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
  allowfullscreen
  loading="lazy"></iframe>
```

The MP4 is ignored by git (`*.mp4`). Do not force-add `demo/Chanh-UI-Demo.mp4`; only the poster and notes belong in the repository.

## Repository name

The canonical URL, Open Graph tags and GitHub links currently assume the repository is named **`lemond`** (the current remote). If the repository is renamed (for example back to `vscode-chanh`), update:

- the `canonical` and `og:url` values in [`index.html`](index.html)
- the absolute `og:image` / `twitter:image` URLs
- the GitHub links in the header, footer and install section

Relative links to `./demo/`, `./mockup/` and `./assets/` do not need changing.

## Structure

```
website/
├─ index.html              # landing page
├─ styles.css              # site theme
├─ site.js                 # nav, YouTube link, copy, reveal
├─ 404.html
├─ assets/
│  ├─ chanh.svg            # logo / favicon
│  └─ chanh-in-vscode.png  # real extension screenshot
├─ demo/                   # poster + notes (MP4 excluded)
└─ mockup/                 # self-contained interactive mockup
```

## Notes

- No build step and no runtime dependencies.
- Only the poster frame is committed; the demo MP4 stays out of git and is published on YouTube.
- `mockup/` is fully self-contained and can be opened directly or served at `/mockup/`.
