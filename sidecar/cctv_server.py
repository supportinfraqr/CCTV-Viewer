#!/usr/bin/env python3
"""Local RTSP -> MJPEG server used by the CCTV Viewer desktop app."""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlparse, urlsplit, urlunsplit

os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|stimeout;5000000",
)
os.environ.setdefault("OPENCV_FFMPEG_READ_ATTEMPTS", "10000")

import cv2

HOST = "127.0.0.1"
PORT = 8765
TARGET_FPS = 15
JPEG_QUALITY = 78
RECONNECT_DELAY = 2.0
OPEN_TIMEOUT_MS = 8000
READ_TIMEOUT_MS = 8000


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def parent_pid_from_args():
    try:
        index = sys.argv.index("--parent-pid")
        return int(sys.argv[index + 1])
    except (ValueError, IndexError):
        return None


def watch_parent(pid, stop_event):
    """Exit the sidecar if the desktop app disappears unexpectedly."""
    if pid is None:
        return

    if os.name == "nt":
        import ctypes

        synchronize = 0x00100000
        infinite = 0xFFFFFFFF
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return
        ctypes.windll.kernel32.WaitForSingleObject(handle, infinite)
        os._exit(0)

    while not stop_event.is_set():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            os._exit(0)
        except PermissionError:
            pass
        stop_event.wait(2.0)


def normalize_stream_url(url):
    """Percent-encode RTSP credentials, including raw @ characters in passwords."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return url
    if parsed.scheme.lower() not in ("rtsp", "rtsps") or "@" not in parsed.netloc:
        return url
    userinfo, host = parsed.netloc.rsplit("@", 1)
    if not userinfo or not host:
        return url
    if ":" in userinfo:
        username, password = userinfo.split(":", 1)
    else:
        username, password = userinfo, ""
    username = quote(unquote(username), safe="")
    password = quote(unquote(password), safe="")
    credentials = f"{username}:{password}" if password else username
    return urlunsplit(
        (parsed.scheme, f"{credentials}@{host}", parsed.path, parsed.query, parsed.fragment)
    )


class CameraStream:
    def __init__(self, name, url):
        self.name = name
        self.url = url
        self.running = True
        self.lock = threading.Lock()
        self.jpeg = None
        self.state = "connecting"
        self.error = ""
        self.last_frame_ts = 0.0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _set_state(self, state, error=""):
        with self.lock:
            self.state = state
            self.error = error

    def _open_capture(self):
        url = normalize_stream_url(self.url)
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            cap.release()
            cap = cv2.VideoCapture(url)
        if not cap.isOpened():
            cap.release()
            return None
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        try:
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS)
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS)
        except Exception:
            pass
        return cap

    def _run(self):
        cap = None
        failures = 0
        has_frame = False
        while self.running:
            if cap is None:
                self._set_state("connecting", "Opening RTSP stream over TCP…")
                cap = self._open_capture()
                if cap is None:
                    self._set_state(
                        "offline",
                        "Could not open the RTSP stream. Check the URL, username, password, and camera network access.",
                    )
                    time.sleep(RECONNECT_DELAY)
                    continue
                failures = 0

            ok, frame = cap.read()
            if not ok or frame is None:
                failures += 1
                if failures >= 3:
                    error = (
                        "The stream opened but no video frames arrived. Check the camera codec or sub-stream."
                        if not has_frame
                        else "The video stream stopped responding. Reconnecting…"
                    )
                    self._set_state("reconnecting", error)
                    try:
                        cap.release()
                    except Exception:
                        pass
                    cap = None
                    time.sleep(RECONNECT_DELAY)
                else:
                    time.sleep(0.2)
                continue

            failures = 0
            has_frame = True
            now = time.time()
            if now - self.last_frame_ts < 1.0 / TARGET_FPS:
                continue
            self.last_frame_ts = now
            ok, buf = cv2.imencode(
                ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
            )
            if ok:
                with self.lock:
                    self.jpeg = buf.tobytes()
                    self.state = "live"
                    self.error = ""

        if cap is not None:
            cap.release()

    def latest(self):
        with self.lock:
            return self.jpeg

    def status(self):
        with self.lock:
            return {
                "name": self.name,
                "state": self.state,
                "lastFrame": self.last_frame_ts,
                "error": self.error,
            }

    def stop(self):
        self.running = False
        self.thread.join(timeout=0.5)


class State:
    lock = threading.Lock()
    streams = []
    cameras = []

    @classmethod
    def configure(cls, cameras):
        with cls.lock:
            for stream in cls.streams:
                stream.stop()
            cls.cameras = [c for c in cameras if isinstance(c, dict) and c.get("url")]
            cls.streams = [
                CameraStream(
                    str(c.get("name") or f"Camera {i + 1}"),
                    str(c["url"]),
                )
                for i, c in enumerate(cls.cameras)
            ]

    @classmethod
    def stream(cls, index):
        with cls.lock:
            return cls.streams[index] if 0 <= index < len(cls.streams) else None

    @classmethod
    def status(cls):
        with cls.lock:
            return [stream.status() for stream in cls.streams]


class Handler(BaseHTTPRequestHandler):
    server_version = "CCTVViewer/1.1"

    def log_message(self, *_args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._json({"ok": True, "cameras": len(State.cameras)})
            return
        if path == "/status":
            cameras = []
            for index, status in enumerate(State.status()):
                cameras.append({"index": index, **status})
            self._json({"ok": True, "cameras": cameras})
            return
        if path.startswith("/camera/") and path.endswith(".mjpg"):
            try:
                index = int(path.split("/")[2].split(".")[0])
            except (ValueError, IndexError):
                index = -1
            stream = State.stream(index)
            if stream is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self._cors()
            self.end_headers()
            try:
                while True:
                    jpeg = stream.latest()
                    if jpeg:
                        self.wfile.write(b"--frame\r\n")
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(
                            f"Content-Length: {len(jpeg)}\r\n\r\n".encode()
                        )
                        self.wfile.write(jpeg)
                        self.wfile.write(b"\r\n")
                    else:
                        time.sleep(0.15)
                    time.sleep(1.0 / 30)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return
        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"CCTV viewer engine is running.")
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/config":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            State.configure(body.get("cameras") or [])
            self._json({"ok": True, "cameras": len(State.cameras)})
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, status=400)


def main():
    watchdog_stop = threading.Event()
    threading.Thread(
        target=watch_parent,
        args=(parent_pid_from_args(), watchdog_stop),
        daemon=True,
    ).start()
    server = Server((HOST, PORT), Handler)
    print(f"CCTV_VIEWER_READY={PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        watchdog_stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
