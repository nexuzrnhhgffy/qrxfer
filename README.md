# Qxfer

Transfer files with animated QR codes — no Wi-Fi, Bluetooth, or USB. One device plays QR frames; the other records the screen, then reconstructs the file.

This is the same idea as Zapya / ShareIt, but the channel is a camera pointed at a screen.

## Why this works

Phone cameras drop frames. The old design sent chunk 1, 2, 3… and waited for every index. A single miss meant waiting for the next loop, and dense QR version 40 with ECC-H was almost unreadable.

Qxfer does three things differently:

1. **Fountain codes (Luby Transform)** — any ~1.2–1.7× distinct packets reconstruct the file. Order does not matter.
2. **QR version 12–25, ECC L** — sparse enough for a camera, with loss handled by the fountain layer instead of QR ECC-H.
3. **Record first, analyze later** — the receiver locks onto the green frame, records the whole clip, then decodes every frame offline (jsQR + ZXing / zxing-cpp).

Each packet is binary (`QXF1`) with a CRC. The file is zlib-compressed once. Sender and receiver share the same integer PRNG, so Python and the browser are interoperable.

## Quick start

```bash
pip install -r requirements.txt
python -m qrxfer
```

This opens the web UI at `http://127.0.0.1:8080/`.

### Send (phone or laptop)

1. Open the **ارسال** tab.
2. Pick a file and a quality preset (start with **متعادل**).
3. Tap **پخش تمام‌صفحه**. Point the other camera at the green-bordered QR.

### Receive (record then analyze)

1. Open the **دریافت** tab on the second device.
2. Start the camera. Align the red guide with the green QR border until it says **قفل شد**.
3. Record the full playback (a bit more than one loop is enough).
4. Stop — analysis runs on the recording, not live.

You can also upload a video that was recorded with the stock camera app.

## CLI

```bash
# Encode a looping MP4 (plays well on a TV)
python -m qrxfer send photo.jpg -o photo.mp4 --preset balanced

# Live OpenCV window (desktop)
python -m qrxfer send photo.jpg --preview

# Record from webcam, then decode
python -m qrxfer receive --camera 0 -o ./out

# Decode a file you already recorded
python -m qrxfer receive capture.mp4 -o ./out
```

Presets:

| Preset     | QR version | FPS | When to use                    |
|------------|------------|-----|--------------------------------|
| reliable   | 12         | 3   | Phone, distance, dim light     |
| balanced   | 18         | 5   | Default                        |
| fast       | 25         | 8   | Close, bright, large screen    |

## Tips

- Fill the camera with the green frame. Motion blur kills dense QR codes.
- Keep the sender screen at high brightness, auto-brightness off.
- For larger files use `fast` only if the lock stays solid.
- Both devices need the app beforehand (air-gap: install while you still have a network).
- This channel is optical and unauthenticated. Encrypt anything sensitive before sending.

## Tests

```bash
python -m unittest discover -s tests -v
```
