# Qxfer

One page. Two buttons. Send a file with light.

1. **ارسال** compresses the file with maximum lossless LZMA, shows a handshake code.
2. **دریافت** reads that code, shows its own camera capabilities back.
3. Both sides agree on FPS and QR density, then the file is sent as binary QR frames (not Base64 — byte mode is ~33% denser).

## Run

```bash
pip install -r requirements.txt
python -m qrxfer
```

Open `http://127.0.0.1:8080/` on both devices.

- Sender: tap **ارسال**, pick a file, point the other phone at the green code.
- Receiver: tap **دریافت**, scan the sender code, show the reply code to the sender.
- After sync, keep the phones still until download appears.

CLI for encoding/decoding a video file is unchanged:

```bash
python -m qrxfer send photo.jpg -o photo.mp4
python -m qrxfer receive capture.mp4 -o ./out
```

## Tests

```bash
python -m unittest discover -s tests -v
```
