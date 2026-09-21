# RemNote Pronunciation

RemNote Pronunciation adds text-to-speech audio to an existing pronunciation
descriptor. It uses a RemNote plugin and a small Python server backed by
`edge-tts`.

## How it works

Create a vocabulary Rem and one pronunciation child:

```text
- passen
    - Uitspraak
```

Add the plugin's **TTS** PowerUp to the pronunciation child. That explicit
PowerUp attachment triggers generation. The plugin reads the direct parent text
(`passen`) and the child label, then asks the server to generate speech. The
server selects the language and voice from its label profiles, caches the MP3,
and returns a stable audio URL. The plugin writes the audio into the
pronunciation label's back text.

The TTS PowerUp opts the child into automatic updates. Editing the parent text
regenerates its audio. The listener waits briefly while RemNote finishes a burst
of edits, so pasting several Rems does not send duplicate requests for the same
pronunciation. The manual **Generate Pronunciation for Focused Rem** command
remains available for retrying or forcing a fresh generation.

The same flow works with these labels:

```text
Uitspraak      → Dutch
Pronunciation  → English
发音            → Chinese
```

The descriptor keeps Extra Card Detail, with practice disabled. Re-running the
command updates the existing descriptor and reuses the cached MP3.

## Server configuration

Copy the example configuration:

```bash
cp server/example.config.toml server/config.toml
```

Edit `server/config.toml` to set the server URL, fallback profile, label
profiles, CORS origins, allow-lists, and optional bearer token. The server reads
that file by default. Set `CONFIG_FILE` to use another TOML file. Environment
variables override TOML values.

For RemNote Cloud to fetch audio, `public_base_url` must be a public HTTPS URL.
`http://localhost:8765` works for local testing but cannot be reached by the
cloud upload service.

## Run the server

With Python and `uv`:

```bash
uv run --project server uvicorn --app-dir server app.main:app --reload --port 8765
```

Check that it is running:

```bash
curl http://localhost:8765/health
```

Expected response:

```json
{"status":"ok"}
```

The server stores cached MP3 files in `server/data/audio/`.

## Run with Docker

Docker Compose builds the server and persists the audio cache on the host:

```bash
docker compose up --build -d
curl http://localhost:8765/health
```

The Compose service mounts `server/config.toml` read-only and keeps generated
files in `server/data/audio/` when the container is recreated.

## Run the plugin

From `plugin/`:

```bash
npm install
npm run check-types
npm run dev
```

The plugin is served at `http://localhost:8080`. In RemNote, open
`Settings → Plugins → Build → Develop from localhost` and enter:

```text
http://localhost:8080
```

To build the uploadable plugin ZIP:

```bash
mise run plugin:package
```

This creates `plugin/PluginZip.zip` from the contents of `plugin/dist/`.

Set the plugin's **Host** setting to the pronunciation server base URL. The
default is `http://localhost:8765`. The optional bearer token and speech rate
are also plugin settings. Language and voice are configured on the server, not
in the plugin. The plugin is enabled for mobile, but mobile users need a public
HTTPS plugin URL and a public HTTPS TTS server; `localhost` only works on the
development computer.

## API

```http
GET  /health
POST /api/pronunciation
GET  /audio/{hash}.mp3
```

The plugin sends:

```json
{
  "text": "passen",
  "label": "Uitspraak",
  "rate": "+0%",
  "pitch": "+0Hz"
}
```

The response includes the public audio URL, cache hash, input text, and the
language and voice selected by the server:

```json
{
  "audioUrl": "https://example.com/audio/<hash>.mp3",
  "hash": "<hash>",
  "text": "passen",
  "language": "nl-NL",
  "voice": "nl-NL-FennaNeural"
}
```

## Verification

```bash
cd plugin
npm run check-types
npm run build

cd ../server
python -m compileall -q app tests
uv run --project . pytest
```

The automated checks cover plugin compilation, server syntax, MP3 caching,
failure cleanup, label profile selection, and TOML loading. Test the final
RemNote behavior with a focused pronunciation label and a public HTTPS audio
endpoint before deployment.
