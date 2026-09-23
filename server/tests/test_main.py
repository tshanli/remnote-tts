from pathlib import Path

from fastapi.testclient import TestClient

from app import main


class FakeCommunicate:
    calls = 0
    voices: list[str] = []

    def __init__(self, text: str, *, voice: str, rate: str, pitch: str) -> None:
        self.text = text
        self.voice = voice
        self.rate = rate
        self.pitch = pitch
        type(self).voices.append(voice)

    async def save(self, path: str) -> None:
        type(self).calls += 1
        Path(path).write_bytes(b"fake-mp3")


def test_toml_config_is_loaded_and_environment_overrides(tmp_path, monkeypatch):
    config_file = tmp_path / "config.toml"
    config_file.write_text(
        """
default_language = "de-DE"
default_voice = "de-DE-ConradNeural"
default_rate = "-10%"
default_pitch = "+3Hz"

[label_profiles."Wort"]
language = "de-DE"
voice = "de-DE-KatjaNeural"
"""
    )
    monkeypatch.setenv("CONFIG_FILE", str(config_file))
    monkeypatch.setenv("DEFAULT_LANGUAGE", "fr-FR")

    settings = main.Settings.from_env()

    assert settings.default_language == "fr-FR"
    assert settings.default_voice == "de-DE-ConradNeural"
    assert settings.rate == "-10%"
    assert settings.pitch == "+3Hz"
    assert settings.label_profiles["wort"] == ("de-DE", "de-DE-KatjaNeural")


def test_tts_is_cached(tmp_path, monkeypatch):
    FakeCommunicate.calls = 0
    FakeCommunicate.voices = []
    monkeypatch.setattr(main.edge_tts, "Communicate", FakeCommunicate)
    settings = main.Settings(
        public_base_url="https://example.test",
        audio_dir=tmp_path,
        rate="0%",
        pitch="0Hz",
        cors_origins=("http://localhost:8080",),
    )
    client = TestClient(main.create_app(settings))
    payload = {"text": "passen", "label": "Uitspraak"}

    first = client.post("/api/tts", json=payload)
    second = client.post("/api/tts", json=payload)
    legacy = client.post("/api/pronunciation", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert legacy.status_code == 404
    assert first.json() == second.json()
    assert FakeCommunicate.calls == 1
    assert first.json()["rate"] == "+0%"
    assert first.json()["pitch"] == "+0Hz"
    assert len(list(tmp_path.glob("*.mp3"))) == 1

    audio = client.get(first.json()["audioUrl"].replace("https://example.test", ""))
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/mpeg")
    assert audio.content == b"fake-mp3"


def test_label_selects_server_language_and_voice(tmp_path, monkeypatch):
    FakeCommunicate.calls = 0
    FakeCommunicate.voices = []
    monkeypatch.setattr(main.edge_tts, "Communicate", FakeCommunicate)
    settings = main.Settings(
        audio_dir=tmp_path,
        label_profiles={"pronunciation": ("en-US", "en-US-AriaNeural")},
        default_language="nl-NL",
        default_voice="nl-NL-FennaNeural",
    )
    client = TestClient(main.create_app(settings))

    response = client.post(
        "/api/tts",
        json={"text": "test", "label": "Pronunciation"},
    )

    assert response.status_code == 200
    assert response.json()["language"] == "en-US"
    assert response.json()["voice"] == "en-US-AriaNeural"
    assert FakeCommunicate.voices == ["en-US-AriaNeural"]


def test_server_uses_configured_rate_and_pitch(tmp_path, monkeypatch):
    class RecordingCommunicate(FakeCommunicate):
        instances: list["RecordingCommunicate"] = []

        def __init__(self, text: str, *, voice: str, rate: str, pitch: str) -> None:
            super().__init__(text, voice=voice, rate=rate, pitch=pitch)
            type(self).instances.append(self)

    RecordingCommunicate.instances = []
    monkeypatch.setattr(main.edge_tts, "Communicate", RecordingCommunicate)
    settings = main.Settings(
        audio_dir=tmp_path,
        rate="-15%",
        pitch="+2Hz",
    )
    client = TestClient(main.create_app(settings))

    response = client.post(
        "/api/tts",
        json={
            "text": "passen",
            "label": "Uitspraak",
            "rate": "+99%",
            "pitch": "+99Hz",
        },
    )

    assert response.status_code == 200
    assert response.json()["rate"] == "-15%"
    assert response.json()["pitch"] == "+2Hz"
    assert RecordingCommunicate.instances[0].rate == "-15%"
    assert RecordingCommunicate.instances[0].pitch == "+2Hz"


def test_failed_generation_leaves_no_mp3(tmp_path, monkeypatch):
    class FailingCommunicate:
        def __init__(self, *args, **kwargs):
            pass

        async def save(self, path: str) -> None:
            Path(path).write_bytes(b"")
            raise RuntimeError("upstream failed")

    monkeypatch.setattr(main.edge_tts, "Communicate", FailingCommunicate)
    client = TestClient(
        main.create_app(
            main.Settings(
                audio_dir=tmp_path,
                cors_origins=("http://localhost:8080",),
            )
        )
    )

    response = client.post(
        "/api/tts",
        json={
            "text": "passen",
            "language": "nl-NL",
            "voice": "nl-NL-FennaNeural",
        },
    )

    assert response.status_code == 502
    assert list(tmp_path.iterdir()) == []
