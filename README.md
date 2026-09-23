# RemNote TTS

RemNote TTS adds an audio player to a Rem through two small applications:

- `plugin/` is the RemNote plugin.
- `server/` is the TTS server that generates and caches MP3 files with
  `edge-tts`.

## How it works

Create a source Rem and a child Rem whose label is configured on the server:

```text
- passen
    - Uitspraak
```

Attach the **TTS** PowerUp to the child. The plugin reads the child's direct
parent text, sends the text and label to the configured server, and inserts the
returned audio player into the child's back text. The child keeps Extra Card
Detail and practice is disabled.

The TTS PowerUp enables automatic generation. Editing the parent text causes a
new MP3 to be generated after a short debounce. The command **Generate TTS
Audio for Focused Rem** and the sidebar button remain available for retries or
forced regeneration.

The default label profiles are:

| Label | Language | Voice |
| --- | --- | --- |
| `Uitspraak` | Dutch | `nl-NL-FennaNeural` |
| `Pronunciation` | English | `en-US-AriaNeural` |
| `发音` | Chinese | `zh-CN-XiaoxiaoNeural` |

The server can replace these profiles and defines the fallback language, voice,
rate, and pitch.

## Privacy and audio access

The plugin sends the direct parent text and child label to the **Host** server
configured in the plugin settings. That server sends the text through
Microsoft's online speech service using `edge-tts` to generate the audio.

Generated MP3 files are served at the URL returned by the server. Anyone who
has an audio URL can request and play that file; the audio endpoint is not
protected by the optional generation bearer token. Do not use this service for
sensitive text unless you trust the configured server and the URL sharing
model. Use a public HTTPS URL when RemNote Cloud must fetch the audio.

## Configure the server

Create the TOML configuration file:

```bash
cp server/example.config.toml server/config.toml
```

Set `public_base_url` to the URL that RemNote can reach. The file also
configures the fallback profile, rate, pitch, label profiles, CORS origins,
allow-lists, and optional bearer token. Environment variables override TOML
values; set `CONFIG_FILE` to use another file.

For local testing, `http://localhost:8765` is sufficient. RemNote Cloud needs
a public HTTPS endpoint, such as a server behind a suitable tunnel or reverse
proxy.

## Run the server

With Python and `uv`:

```bash
uv run --project server uvicorn --app-dir server app.main:app --reload --port 8765
curl http://localhost:8765/health
```

Or with Docker Compose:

```bash
docker compose up --build -d
curl http://localhost:8765/health
```

The server stores cached files in `server/data/audio/`. Compose persists this
directory when the container is recreated.

## Run the plugin

From `plugin/`:

```bash
npm install
npm run check-types
npm run dev
```

The development server runs at `http://localhost:8080`. In RemNote, open
`Settings → Plugins → Build → Develop from localhost` and enter that URL.

Set the plugin's **Host** setting to the server base URL, for example
`http://localhost:8765`. The optional bearer token is sent only when requesting
new audio. Language, voice, rate, pitch, and label profiles are configured on
the server.

To build the uploadable plugin ZIP:

```bash
mise run plugin:package
```

This creates `plugin/PluginZip.zip` from `plugin/dist/`.

## API

```http
GET  /health
POST /api/tts
GET  /audio/{hash}.mp3
```

Request:

```json
{
  "text": "passen",
  "label": "Uitspraak"
}
```

The response contains the stable public audio URL and the server-selected
profile:

```json
{
  "audioUrl": "https://example.com/audio/<hash>.mp3",
  "hash": "<hash>",
  "text": "passen",
  "language": "nl-NL",
  "voice": "nl-NL-FennaNeural",
  "rate": "+0%",
  "pitch": "+0Hz"
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

These checks verify the plugin bundle, server syntax, caching, failure cleanup,
profile selection, and TOML loading. Test the final RemNote flow separately
with a TTS PowerUp and a public HTTPS audio endpoint.

## Privacy

The direct parent text is sent to the Host configured in the plugin. The Host
then sends the text through Microsoft's online speech service using [`edge-tts`](https://github.com/rany2/edge-tts).
If the Host belongs to someone else, that server can receive and process the
text.

The generated MP3 is served at the public audio URL returned by the server.
Anyone who has that URL can request and play the audio. The optional bearer
token protects audio generation requests; it does not protect an audio URL.
Avoid using the plugin for sensitive text unless you trust the server and the
URL sharing model.
