# FileDrop — direct local transfer

FileDrop sends files directly from one browser to another over the local WiFi network. The sender chooses a file, shares a QR code, and the receiver scans it and taps **Receive file**. The sender must keep FileDrop open until the transfer finishes.

The Django server never receives, stores, or relays file bytes. It only holds a small WebRTC connection offer and answer in memory, for at most 15 minutes, so the two browsers can find each other. Sessions end after one receiver completes, the sender ends the share, or they expire.

## Run it

In the first terminal, start the signaling API:

```bash
cd "/home/sahil/Downloads/Desktop/LAN File Sharing via QR Code"
source .venv/bin/activate
cd filedrop_backend
python manage.py runserver 0.0.0.0:8000
```

In a second terminal, start the web app:

```bash
cd "/home/sahil/Downloads/Desktop/LAN File Sharing via QR Code/filedrop-frontend"
npm start
```

Open the Network URL printed by Vite, for example `http://192.168.68.66:3000`, instead of `localhost`. That is important because a phone’s `localhost` points to the phone itself. Both devices must be connected to the same WiFi. Allow inbound ports 3000 and 8000 in the host's private-network firewall.

The frontend automatically contacts port 8000 on the same hostname. To use a different backend, create `filedrop-frontend/.env` from `.env.example` and set `VITE_API_BASE=http://<LAN-IP>:8000/api`.

## Notes

- The transfer uses a direct WebRTC data channel with local network candidates only. It does not call STUN, TURN, cloud storage, or external APIs.
- WiFi guest mode/client isolation can prevent devices from connecting. Disable that setting or use a regular private WiFi network.
- Current Chrome, Edge, Firefox, and Safari are supported. On ordinary LAN HTTP, some browsers must hold the received file in browser memory before saving it; FileDrop limits that fallback to 128 MB. Serving the frontend through trusted HTTPS enables direct disk saving for larger files in compatible browsers.
- The older `media/` files and SQLite rows from the previous server-upload version are no longer used. They have been preserved and are not exposed by the active API.
- `ALLOWED_HOSTS=['*']` and `CORS_ALLOW_ALL_ORIGINS=True` are LAN-development settings. Restrict them before using this on a broader network.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/sessions/` | Create a short-lived session from the sender's WebRTC offer and return its QR image |
| GET | `/api/sessions/<uuid>/` | Receiver reads the offer; sender polls for the receiver answer |
| POST | `/api/sessions/<uuid>/` | Receiver supplies the answer |
| DELETE | `/api/sessions/<uuid>/` | Sender ends the session |

Run checks with `python manage.py test` in `filedrop_backend` and `npm run build` in `filedrop-frontend`.
