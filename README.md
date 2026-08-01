# Spettro Desktop

A desktop UI for the [spettro](https://spettro.app) command-line agent, for
Linux and Windows. Built with Electron, React and TypeScript (electron-vite +
electron-builder). It is a port of the macOS Spettro.app: chat with an ACP
agent, an integrated terminal (node-pty + xterm.js), and a remote host that
lets the iPhone app pair over the local network.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the codebase is laid out.

## Development

```sh
npm install        # installs deps and rebuilds native modules for Electron
npm run dev        # start the app with hot reload (electron-vite dev)
npm run typecheck  # type-check main/preload and renderer
npm run build      # compile main/preload/renderer into out/
```

## Packaging locally

```sh
npm run pack:linux   # build + package AppImage into release/
npm run pack:win     # build + package NSIS installer + MSI into release/
```

Icons live in `build/` (`icon.png` for Linux, `icon.ico` for Windows).

## Releasing

Releases are fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).
Tag a version and push the tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

CI then builds on Linux and Windows, stamps the version from the tag into
`package.json`, and publishes a GitHub Release named after the tag with:

- `Spettro-1.0.0-linux-x86_64.AppImage`
- `Spettro-Setup-1.0.0.exe` (NSIS installer)
- `Spettro-1.0.0.msi`

The tag must be of the form `vX.Y.Z`; the `v` prefix is stripped for the
package version.
