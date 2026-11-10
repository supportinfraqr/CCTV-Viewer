# CCTV Viewer

A simple Windows desktop viewer for local RTSP cameras. It is a standalone demo and is not part of any other product.

## Features

- Add, edit and remove RTSP cameras.
- 1, 2, 4 and 6 camera layouts.
- Click a camera to maximize it; press `Esc` to return to the grid.
- Three-dot camera menu with stream details and actions.
- Full-bleed camera tiles with live stream status and clear connection errors.
- RTSP over TCP with percent-encoded credentials for passwords containing `@`.
- Camera configuration stays on the local PC.

## Download

Download the latest Windows installer from the repository Releases page:

`Releases -> CCTV Viewer -> CCTV-Viewer-Setup.exe`

## Build

The Windows installer is built with GitHub Actions on `windows-latest`.

The Tauri shell starts a bundled local video engine (`cctv-server.exe`) that converts RTSP to MJPEG for the WebView. The engine is built with PyInstaller from `sidecar/cctv_server.py`.

Tag a build with:

```bash
git tag cctv-tauri-v1.0.2
git push origin cctv-tauri-v1.0.2
```

The workflow uploads the installer as a workflow artifact and attaches it to the GitHub release.
