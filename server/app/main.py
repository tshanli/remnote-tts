from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import edge_tts
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_AUDIO_DIR = PROJECT_ROOT / "data" / "audio"
DEFAULT_CONFIG_FILE = PROJECT_ROOT / "config.toml"
DEFAULT_CORS_ORIGINS = (
    "http://localhost:8080",
    "http://127.0.0.1:8080",
)
DEFAULT_LABEL_PROFILES = {
    "uitspraak": ("nl-NL", "nl-NL-FennaNeural"),
    "pronunciation": ("en-US", "en-US-AriaNeural"),
    "发音": ("zh-CN", "zh-CN-XiaoxiaoNeural"),
}
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _string_set(value: object, default: tuple[str, ...] = ()) -> frozenset[str]:
    if value is None:
        return frozenset(default)
    if isinstance(value, str):
        return frozenset(item.strip() for item in value.split(",") if item.strip())
    if isinstance(value, list):
        return frozenset(str(item).strip() for item in value if str(item).strip())
    raise ValueError("Expected a comma-separated string or a list of strings")


def _label_profiles(value: object) -> dict[str, tuple[str, str]]:
    if not value:
        return dict(DEFAULT_LABEL_PROFILES)

    parsed = json.loads(value) if isinstance(value, str) else value
    if not isinstance(parsed, dict):
        raise TypeError("LABEL_PROFILES must be a JSON object")

    profiles: dict[str, tuple[str, str]] = {}
    for label, profile in parsed.items():
        if not isinstance(label, str) or not isinstance(profile, dict):
            raise TypeError("Each LABEL_PROFILES entry must be an object")
        language = profile.get("language")
        voice = profile.get("voice")
        if not isinstance(language, str) or not isinstance(voice, str):
            raise TypeError("Each label profile needs language and voice strings")
        profiles[label.strip().casefold()] = (language.strip(), voice.strip())
    return profiles


def _load_config() -> dict[str, object]:
    configured_path = Path(os.environ.get("CONFIG_FILE", str(DEFAULT_CONFIG_FILE)))
    path = (
        configured_path
        if configured_path.is_absolute()
        else PROJECT_ROOT / configured_path
    )
    if not path.is_file():
        return {}

    with path.open("rb") as config_file:
        parsed = tomllib.load(config_file)
    server_config = parsed.get("server", parsed)
    if not isinstance(server_config, dict):
        raise TypeError("The [server] section in config.toml must be a table")
    return server_config


def _setting(
    config: dict[str, object],
    env_name: str,
    config_name: str,
    default: object,
) -> object:
    return (
        os.environ[env_name]
        if env_name in os.environ
        else config.get(config_name, default)
    )


@dataclass(frozen=True)
class Settings:
    public_base_url: str = "http://localhost:8765"
    audio_dir: Path = DEFAULT_AUDIO_DIR
    auth_token: str | None = None
    default_language: str = "nl-NL"
    default_voice: str = "nl-NL-FennaNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"
    label_profiles: dict[str, tuple[str, str]] = field(
        default_factory=lambda: dict(DEFAULT_LABEL_PROFILES)
    )
    allowed_languages: frozenset[str] = frozenset()
    allowed_voices: frozenset[str] = frozenset()
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS

    @classmethod
    def from_env(cls) -> Settings:
        config = _load_config()
        audio_dir = Path(
            str(_setting(config, "AUDIO_DIR", "audio_dir", str(DEFAULT_AUDIO_DIR)))
        )
        if not audio_dir.is_absolute():
            audio_dir = PROJECT_ROOT / audio_dir
        configured_origins = _string_set(
            _setting(config, "CORS_ORIGINS", "cors_origins", None)
        )
        cors_origins = tuple(configured_origins or DEFAULT_CORS_ORIGINS)
        return cls(
            public_base_url=str(
                _setting(
                    config,
                    "PUBLIC_BASE_URL",
                    "public_base_url",
                    "http://localhost:8765",
                )
            ).rstrip("/"),
            audio_dir=audio_dir,
            auth_token=str(_setting(config, "AUTH_TOKEN", "auth_token", "") or "")
            or None,
            default_language=str(
                _setting(config, "DEFAULT_LANGUAGE", "default_language", "nl-NL")
            ).strip(),
            default_voice=str(
                _setting(config, "DEFAULT_VOICE", "default_voice", "nl-NL-FennaNeural")
            ).strip(),
            rate=str(_setting(config, "DEFAULT_RATE", "default_rate", "+0%")).strip(),
            pitch=str(_setting(config, "DEFAULT_PITCH", "default_pitch", "+0Hz")).strip(),
            label_profiles=_label_profiles(
                _setting(config, "LABEL_PROFILES", "label_profiles", None)
            ),
            allowed_languages=_string_set(
                _setting(config, "ALLOWED_LANGUAGES", "allowed_languages", None)
            ),
            allowed_voices=_string_set(
                _setting(config, "ALLOWED_VOICES", "allowed_voices", None)
            ),
            cors_origins=cors_origins,
        )


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    label: str | None = None


class TtsResponse(BaseModel):
    audioUrl: str
    hash: str
    text: str
    language: str
    voice: str
    rate: str
    pitch: str


def canonical_hash(
    request: TtsRequest,
    language: str,
    voice: str,
    rate: str,
    pitch: str,
) -> str:
    canonical = {
        "text": request.text.strip(),
        "language": language.strip(),
        "voice": voice.strip(),
        "rate": rate.strip(),
        "pitch": pitch.strip(),
    }
    encoded = json.dumps(
        canonical,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _audio_path(settings: Settings, audio_hash: str) -> Path:
    return settings.audio_dir / f"{audio_hash}.mp3"


def _signed_tts_value(value: str, suffix: str) -> str:
    """Accept both user-friendly `0%` and edge-tts's required `+0%` form."""
    value = value.strip()
    if value.endswith(suffix) and value[:1].isdigit():
        return f"+{value}"
    return value


def _check_bearer_token(
    configured_token: str | None, authorization: str | None
) -> None:
    if configured_token is None:
        return

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token, configured_token):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _validate_request(
    request: TtsRequest, settings: Settings
) -> tuple[str, str, str]:
    text = request.text.strip()
    label = (request.label or "").strip().casefold()
    configured_profile = settings.label_profiles.get(label)
    language = (
        configured_profile[0]
        if configured_profile
        else settings.default_language.strip()
    )
    voice = (
        configured_profile[1]
        if configured_profile
        else settings.default_voice.strip()
    )

    if not text:
        raise HTTPException(status_code=422, detail="Text must not be empty")
    if not language:
        raise HTTPException(status_code=422, detail="Language must not be empty")
    if not voice:
        raise HTTPException(status_code=422, detail="Voice must not be empty")
    if settings.allowed_languages and language not in settings.allowed_languages:
        raise HTTPException(status_code=422, detail="Unsupported language")
    if settings.allowed_voices and voice not in settings.allowed_voices:
        raise HTTPException(status_code=422, detail="Unsupported voice")

    return text, language, voice


async def _generate_tts_audio(
    settings: Settings,
    request: TtsRequest,
    audio_hash: str,
    voice: str,
    rate: str,
    pitch: str,
) -> None:
    settings.audio_dir.mkdir(parents=True, exist_ok=True)
    target = _audio_path(settings, audio_hash)
    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            dir=settings.audio_dir,
            prefix=f".{audio_hash}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)

        communicator = edge_tts.Communicate(
            request.text.strip(),
            voice=voice,
            rate=rate,
            pitch=pitch,
        )
        await communicator.save(str(temporary_path))

        if not temporary_path.exists() or temporary_path.stat().st_size == 0:
            raise RuntimeError("TTS server produced no audio")
        os.replace(temporary_path, target)
        temporary_path = None
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="TTS audio generation failed") from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings.from_env()
    generation_lock = asyncio.Lock()
    app = FastAPI(title="RemNote TTS Server")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/tts", response_model=TtsResponse)
    async def tts(
        payload: TtsRequest,
        authorization: str | None = Header(default=None),
    ) -> TtsResponse:
        _check_bearer_token(config.auth_token, authorization)
        text, language, voice = _validate_request(payload, config)
        rate = _signed_tts_value(config.rate, "%")
        pitch = _signed_tts_value(config.pitch, "Hz")
        if not rate:
            raise HTTPException(status_code=422, detail="TTS rate must not be empty")
        if not pitch:
            raise HTTPException(status_code=422, detail="TTS pitch must not be empty")
        audio_hash = canonical_hash(payload, language, voice, rate, pitch)
        target = _audio_path(config, audio_hash)

        if not target.is_file():
            async with generation_lock:
                if not target.is_file():
                    await _generate_tts_audio(config, payload, audio_hash, voice, rate, pitch)

        return TtsResponse(
            audioUrl=f"{config.public_base_url}/audio/{audio_hash}.mp3",
            hash=audio_hash,
            text=text,
            language=language,
            voice=voice,
            rate=rate,
            pitch=pitch,
        )

    @app.get("/audio/{audio_hash}.mp3")
    async def audio(audio_hash: str) -> FileResponse:
        if not HASH_PATTERN.fullmatch(audio_hash):
            raise HTTPException(status_code=404, detail="TTS audio not found")

        target = _audio_path(config, audio_hash)
        if not target.is_file():
            raise HTTPException(status_code=404, detail="TTS audio not found")
        return FileResponse(target, media_type="audio/mpeg")

    return app


app = create_app()
