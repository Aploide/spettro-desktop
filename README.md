# Spettro Desktop

A desktop UI for the [spettro](https://spettro.app) command-line agent, for
Linux and Windows. Built with Electron, React and TypeScript (electron-vite +
electron-builder). It is a port of the macOS Spettro.app: chat with an ACP
agent, an integrated terminal (node-pty + xterm.js), and a remote host that
lets the iPhone and Android apps pair over the local network, and reach it
over the internet through a Cloudflare tunnel.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the codebase is laid out.

## Remote access over the internet

Settings › Remote pairs a phone on the same network. To reach this computer
when the phone is somewhere else, turn on **Access over the internet** there.
It uses a Cloudflare named tunnel, which is free; you need a free Cloudflare
account and a domain on Cloudflare.

1. In the Cloudflare dashboard, open Zero Trust › Networks › Tunnels and
   create a tunnel (type Cloudflared).
2. Copy the install command it shows and paste it into Spettro (no need to
   run it). Spettro keeps only the token, in a file only you can read, and
   runs `cloudflared` itself: the one on your `PATH`, or the latest release
   downloaded once and checked against its published SHA-256.
3. Add a public hostname on your domain with service **HTTP** and URL
   **`localhost:7879`** (the port is configurable in Spettro).
4. Turn the switch on. Paired phones learn the address the next time they
   connect on the same network, and from then on reach this computer from
   anywhere.

New phones still pair on the same network unless you tick **Allow pairing
over the internet**. Cloudflare ends TLS at its edge and re-encrypts to this
computer, so it carries your chats readable in transit; Spettro's own pairing
keys and sign-in proofs still guard who gets in. Remove a phone from the same
pane to shut it out. [ARCHITECTURE.md](ARCHITECTURE.md) has the details.

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
