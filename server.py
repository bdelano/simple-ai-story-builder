import io
import numpy as np
import asyncio
import tempfile
import struct
import json
import httpx
import soundfile as sf
from quart import Quart, request, Response, send_from_directory, jsonify
from kokoro_onnx import Kokoro
from config import KOKORO_MODEL, KOKORO_VOICES, OLLAMA_URL, LLM_MODEL, VOICE

import whisper
stt_model = whisper.load_model("base")  # small, medium, large, etc.

app = Quart(__name__)

# Load Kokoro ONNX
kokoro = Kokoro(KOKORO_MODEL, KOKORO_VOICES)

# Load Whisper (tiny or base recommended for low latency)
whisper_model = whisper.load_model("base")

@app.route("/")
async def index():
    return await send_from_directory("static", "index.html")


@app.post("/asr")
async def asr():
    """Receive audio (wav/pcm) and transcribe with Whisper."""
    data = await request.data
    audio_data, sr = sf.read(io.BytesIO(data), dtype="float32")
    result = whisper_model.transcribe(audio_data, fp16=False)
    return {"text": result["text"]}


@app.route("/stt", methods=["POST"])
async def transcribe():
    """Convert uploaded WAV to text using Whisper."""
    #payload = await request.get_json()
    #audio_file = payload.get("audio", "")
    audio_file = (await request.files)["audio"]

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
        await audio_file.save(tmp.name)
        wav_path = tmp.name

    # Use Whisper to transcribe
    result = stt_model.transcribe(wav_path)
    text = result["text"]
    return jsonify({"text": text})

@app.post("/story")
async def story():
    payload = await request.get_json()
    prompt = payload.get("prompt", "")

    async def generate():
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST", OLLAMA_URL,
                json={"model": LLM_MODEL, "prompt": prompt, "stream": True}
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                        if "response" in data:
                            yield data["response"]
                    except json.JSONDecodeError:
                        continue

    return Response(generate(), content_type="text/plain")

@app.post("/tts_stream")
async def tts_stream():
    """
    Async low-latency TTS using kokoro-onnx.
    Streams raw little-endian float32 PCM. First bytes contain "SR:<rate>\\n".
    """
    data = await request.get_json()
    text = (data or {}).get("text", "")
    voice = (data or {}).get("voice", VOICE)

    async def pcm_stream():
        first = True
        async for samples, sr in kokoro.create_stream(text, voice=voice):
            chunk = np.asarray(samples, dtype=np.float32).tobytes()
            if first:
                yield b"SR:" + str(sr).encode("ascii") + b"\n" + chunk
                first = False
            else:
                yield chunk

    return Response(pcm_stream(), content_type="application/octet-stream")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)

