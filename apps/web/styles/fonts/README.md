# Inter variable font

Unmodified normal-style `InterVariable.woff2` from the official [Inter v4.1 release](https://github.com/rsms/inter/releases/tag/v4.1), vendored from [the tagged vendor file](https://github.com/rsms/inter/blob/v4.1/docs/font-files/InterVariable.woff2). Its variable weight range is 100–900. Normal styles and synthesized italics preserve the existing application font coverage; no italic asset is preloaded unnecessarily.

The included, unmodified `LICENSE.txt` is the vendor's SIL Open Font License 1.1 from [the same tag](https://github.com/rsms/inter/blob/v4.1/LICENSE.txt). Keep it with the font when redistributing.

SHA-256:

- `InterVariable.woff2`: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`
- `LICENSE.txt`: `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`

`styles/fonts.ts` uses `next/font/local`; Next generates same-origin hashed font/CSS assets and an adjusted Arial fallback. The custom app declares the resulting family in the global root CSS variable, shared by body styles and MUI typography, so body-mounted dialogs/menus inherit the same font. There is no Google Fonts stylesheet, preconnect or font fetch in the application.
