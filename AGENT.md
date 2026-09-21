# RemNote TTS

## Project purpose

RemNote TTS adds text-to-speech audio to a Rem. The repository contains two
small applications:

- `plugin/`: a TypeScript RemNote plugin.
- `server/`: a Python HTTP server that generates and caches MP3 files with
  `edge-tts`.

The normal RemNote flow is:

1. Create a vocabulary Rem, such as `passen`.
2. Add a child Rem with the label configured on the TTS server.
3. Attach the `TTS` PowerUp to that child Rem.
4. The plugin reads the direct parent Rem and sends its text and label to the
   server.
5. The server chooses the configured language, voice, rate, and pitch, then
   generates or reuses the MP3.
6. The plugin inserts the audio into the TTS Rem's back text.

The manual `Generate TTS Audio for Focused Rem` command remains available for
retrying or forcing a fresh generation.

The visible result is:

```text
- passen
    - Uitspraak ; [audio player]
```

The descriptor keeps Extra Card Detail, but practice is disabled and its
practice direction is set to `none`. The audio URL is stored as hidden TTS
metadata, never as ordinary card text.

## Scope and boundaries

- Keep the repository split into the `plugin/` and `server/` applications.
- Keep the plugin in TypeScript and the server in Python.
- Use the filesystem for MP3 caching. Do not add a database, queue, or object
  storage layer unless the project requirements change.
- Support one focused TTS Rem at a time. Do not add library-wide
  scanning or batch generation without a separate requirement.
- Use the RemNote plugin API directly, including `plugin.richText.audio(url)`.
- Keep secrets out of source control.
- Keep visible Rem mutations after the server returns a valid audio URL.
- Keep Docker support limited to the existing Compose service and persistent
  audio volume.

## Plugin behavior

The plugin registers:

- the `TTS` custom Power-up with hidden slots for status, hash, language, voice,
  and generated URL;
- the `Generate TTS Audio for Focused Rem` command;
- a right-sidebar widget that runs the same command;
- debounced Rem-change listeners that detect TTS-tagged Rems from global,
  PowerUp, focus, and per-Rem parent/child changes;
- settings for the server `Host` and an optional bearer token.

Language, voice, rate, and pitch are server configuration. The plugin sends the
focused Rem's label and direct parent text. The server resolves the label
through its configured profile map and applies the default profile when no
mapping exists.

The plugin reads the focused Rem with `plugin.focus.getFocusedRem()` and uses
the SDK rich-text helpers to convert Rem text to plain text. Automatic
generation checks only for the TTS PowerUp and requires the TTS Rem to have a
direct parent with text.

The write sequence is:

1. Request audio from the server.
2. Set the focused label's back text with `plugin.richText.audio(audioUrl)`.
3. Set the Rem type to `SetRemType.DESCRIPTOR`.
4. Add `BuiltInPowerupCodes.ExtraCardDetail`.
5. Disable practice and set the practice direction to `none`.
6. Add the custom `TTS` Power-up and save the returned metadata in its hidden
   slots.

On failure, the plugin shows an error toast and does not change the focused Rem.
Running the command again updates the same TTS Rem instead of creating another
child Rem.

## Server API

The server exposes:

```http
GET  /health
POST /api/tts
GET  /audio/{hash}.mp3
```

The plugin sends requests in this form:

```json
{
  "text": "passen",
  "label": "Uitspraak"
}
```

The server resolves `language` and `voice` from the label profile and returns:

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

Server rules:

- Reject empty text, language, voice, rate, or pitch values.
- Enforce language and voice allow-lists when configured.
- Compute a SHA-256 hash from canonical text, language, voice, rate, and pitch
  values.
- Store files as `data/audio/<hash>.mp3`.
- Return a cached file without calling `edge-tts` again.
- Generate speech with `edge_tts.Communicate(...).save(...)`.
- Serve audio with `Content-Type: audio/mpeg`.
- Build audio URLs from `PUBLIC_BASE_URL`; never return a filesystem path.
- Support CORS for the local RemNote plugin.
- Support optional bearer-token authentication for generation.
- Do not log the token or expose server filesystem paths.

## Configuration

The server reads `server/config.toml` by default. A public setup can start from
the example file:

```bash
cp server/example.config.toml server/config.toml
```

The TOML file configures `public_base_url`, the audio directory, the fallback
language and voice, the default rate and pitch, CORS origins, allow-lists, and
label profiles. Environment variables such as `PUBLIC_BASE_URL` override TOML
values. Set `CONFIG_FILE` to load another TOML file.

The default label profiles are:

```text
Uitspraak      → nl-NL / nl-NL-FennaNeural
Pronunciation  → en-US / en-US-AriaNeural
发音            → zh-CN / zh-CN-XiaoxiaoNeural
```

For RemNote Cloud to fetch an audio file, `PUBLIC_BASE_URL` must resolve to a
public HTTPS endpoint. A local URL such as `http://localhost:8765` is suitable
for local playback but is not reachable by the cloud upload service.

## Local development

Start the server from the repository root:

```bash
uv run --project server uvicorn --app-dir server app.main:app --reload --port 8765
```

Start the plugin from `plugin/`:

```bash
npm install
npm run check-types
npm run dev
```

The plugin development server runs at `http://localhost:8080`. Load it in
RemNote through `Settings → Plugins → Build → Develop from localhost` and enter
that URL. Mobile requires the plugin and TTS server to use public HTTPS URLs;
it cannot reach a server running only on your computer's `localhost`.

## Docker

The Compose service builds the server, mounts `server/config.toml` read-only,
and persists generated audio in `server/data/audio/`:

```bash
docker compose up --build -d
curl http://localhost:8765/health
```

## Verification

Run the checks from the repository root or the application directory as shown:

```bash
cd plugin
npm run check-types
npm run build

cd ../server
python -m compileall -q app tests
uv run --project . pytest
```

These checks cover the plugin bundle, server syntax, caching, failure cleanup,
label profile selection, and TOML loading. RemNote UI behavior and cloud audio
upload still need to be tested against the target RemNote account and a public
HTTPS endpoint.
