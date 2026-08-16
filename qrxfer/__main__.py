"""qrxfer command line: send, receive, or open the web UI."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile

from .constants import DEFAULT_PRESET, PRESETS, ensure_file_size
from .decoder import VideoDecoder, record_camera
from .generator import QRVideoGenerator


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s")


def cmd_send(args) -> int:
    ensure_file_size(os.path.getsize(args.input), args.input)
    gen = QRVideoGenerator(
        qr_version=args.qr_version,
        fps=args.fps,
        preset=args.preset,
        overhead=args.overhead,
        repeats=args.repeats,
        qr_size=args.qr_size,
    )
    if args.preview:
        gen.preview(args.input)
        return 0
    output = args.output or os.path.splitext(os.path.basename(args.input))[0] + "_qrxfer.mp4"
    gen.generate(args.input, output)
    print(f"Wrote {output}")
    return 0


def cmd_receive(args) -> int:
    video = args.video
    if args.camera is not None:
        video = args.record or os.path.join(tempfile.gettempdir(), "qrxfer_capture.mp4")
        record_camera(video, camera_index=args.camera)
    if not video:
        print("Provide a video file or --camera", file=sys.stderr)
        return 2
    decoder = VideoDecoder(progress=lambda msg: print(msg, flush=True))
    ok = decoder.process_video(video)
    if not ok:
        k = decoder.decoder.lt.k
        rec = decoder.decoder.lt.recovered_count
        print(
            f"Could not reconstruct the file. blocks={rec}/{k} "
            f"unique_packets={decoder.decoder.lt.packets_accepted} "
            f"frames_decoded={decoder.frames_decoded}/{decoder.frames_seen}",
            file=sys.stderr,
        )
        return 1
    dest = decoder.save(args.output)
    print(f"Recovered {dest}")
    return 0


def cmd_serve(args) -> int:
    from .server import serve

    serve(args.host, args.port, open_browser=not args.no_browser)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qrxfer",
        description="Transfer files with animated QR codes (record then decode).",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    send = sub.add_parser("send", help="Encode a file into a QR video or live preview")
    send.add_argument("input", help="File to send")
    send.add_argument("-o", "--output", help="Output MP4 path")
    send.add_argument("--preview", action="store_true", help="Loop QR frames on screen")
    send.add_argument("--preset", choices=sorted(PRESETS), default=DEFAULT_PRESET)
    send.add_argument("--qr-version", type=int)
    send.add_argument("--fps", type=int)
    send.add_argument("--qr-size", type=int, default=720)
    send.add_argument("--overhead", type=float, default=1.7)
    send.add_argument("--repeats", type=int, default=2)
    send.set_defaults(func=cmd_send)

    recv = sub.add_parser("receive", help="Record or analyze a video, then reconstruct the file")
    recv.add_argument("video", nargs="?", help="Recorded MP4/WebM to analyze")
    recv.add_argument("-o", "--output", default=".", help="Directory to write the recovered file")
    recv.add_argument("--camera", type=int, nargs="?", const=0, help="Record from this camera index, then analyze")
    recv.add_argument("--record", help="Where to save the camera recording")
    recv.set_defaults(func=cmd_receive)

    srv = sub.add_parser("serve", help="Open the browser send/receive UI")
    srv.add_argument("--host", default="127.0.0.1")
    srv.add_argument("--port", type=int, default=8080)
    srv.add_argument("--no-browser", action="store_true")
    srv.set_defaults(func=cmd_serve)

    return parser


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        argv = ["serve"]
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
