# Teleproto

The browser client bundles teleproto 1.233.0 from the npm distribution. It is loaded on demand by the Telegram plugin. See [the bundled licenses](teleproto-licenses.txt) and [upstream source](https://github.com/sanyok12345/teleproto).

The application has no dependency installation or build step. To replace the vendor file, use a temporary project to install the exact teleproto version and esbuild 0.28.2. Bundle an entry exporting `TelegramClient` from `teleproto`, `StringSession` from `teleproto/sessions` and `Api` from `teleproto/tl` using `esbuild --bundle --format=esm --platform=browser --target=es2022 --minify --legal-comments=external --metafile=bundle-meta.json`. Update the file name in `hm-telegram.js` and refresh license notices for the packages listed in the generated metafile.
