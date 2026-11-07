# Contributing

Thanks for helping improve FrameCue.

## Development

```bash
npm install
npm test
npm run test:e2e
```

The end-to-end suite launches Chromium with an unpacked copy of the extension. Use Node.js 20 or newer.

## Pull requests

- Keep changes focused and explain the user-facing behavior.
- Add or update tests for frame calculations, site rules, or injection behavior.
- Run both `npm test` and `npm run test:e2e` before opening a pull request.
- Do not add default site access. Websites must remain opt-in through the allowlist.
- Do not add analytics, remote code, or silent network requests.

## Reporting bugs

Include the Chrome version, site type, whether the media is HLS, selected frame-rate mode, and steps to reproduce. Remove private URLs and tokens from screenshots and logs.
