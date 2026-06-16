# codespace-bridge

Lets Claude execute commands in a GitHub Codespace terminal via HTTP.

## Setup (run once in your Codespace)

```bash
curl -o ~/bridge.js https://raw.githubusercontent.com/Cal-Starfur/codespace-bridge/main/bridge.js
node ~/bridge.js
```

Then in VS Code:
1. Go to the **Ports** tab
2. Find port **3000** → right-click → Port Visibility → **Public**
3. Copy the forwarded URL (e.g. `https://xxxx-3000.app.github.dev`)
4. Paste the URL + printed token into Claude

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/ping` | None | Health check |
| GET | `/env` | Bearer token | Codespace info |
| POST | `/run` | Bearer token | Run a command |

### POST /run body
```json
{ "cmd": "git pull && devvit upload --just-do-it", "cwd": "/workspaces/Wigglers_Room" }
```

## Security
- Token is random, printed on startup, lives only in memory
- Dangerous commands are blocked by a denylist
- Keep the forwarded URL private — anyone with it + token can run commands
- Port-forward only when actively using; stop the server when done

## Notes
- Server lives at `~/bridge.js` — not inside any project repo
- Compatible with iPad + Safari (no extensions needed)
- Designed for use with the Wigglers Room Devvit pipeline
