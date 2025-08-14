import io
import numpy as np
import asyncio
import tempfile
import struct
import json
import httpx
import soundfile as sf
import os  # Import the os module for file deletion

from quart import Quart, request, Response, send_from_directory, jsonify
from kokoro_onnx import Kokoro
from config import KOKORO_MODEL, KOKORO_VOICES, OLLAMA_URL, LLM_MODEL, VOICE

# Import whisper only once
import whisper

# Load Whisper model once when the application starts
try:
    stt_model = whisper.load_model("base")
except Exception as e:
    print(f"Error loading Whisper model: {e}")
    stt_model = None  # Handle the case where the model fails to load

app = Quart(__name__)

# Load Kokoro ONNX
try:
    kokoro = Kokoro(KOKORO_MODEL, KOKORO_VOICES)
except Exception as e:
    print(f"Error loading Kokoro model: {e}")
    kokoro = None

@app.route("/")
async def index():
    return await send_from_directory("static", "index.html")

@app.route("/stt", methods=["POST"])
async def transcribe_audio():
    """Convert uploaded WAV to text using Whisper."""
    if stt_model is None:
        return jsonify({"error": "Speech-to-text service is not available."}), 503

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided."}), 400

    audio_file = (await request.files)["audio"]

    # Use a try...finally block to ensure the temporary file is deleted
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            await audio_file.save(tmp.name)
            tmp_path = tmp.name

        # Use Whisper to transcribe
        result = stt_model.transcribe(tmp_path)
        text = result.get("text", "")
        return jsonify({"text": text})
    except Exception as e:
        print(f"Error during transcription: {e}")
        return jsonify({"error": "An error occurred during transcription."}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path) # Clean up the temporary file

@app.post("/story")
async def generate_story():
    try:
        payload = await request.get_json()
        prompt = (payload or {}).get("prompt", "")
        if not prompt:
            return jsonify({"error": "Prompt cannot be empty."}), 400

        async def generate():
            async with httpx.AsyncClient() as client:
                try:
                    async with client.stream(
                        "POST", OLLAMA_URL,
                        json={"model": LLM_MODEL,"messages": [{"role":"user","content": prompt}], "stream": True}
                    ) as resp:
                        resp.raise_for_status() # Raise an exception for bad status codes
                        async for line in resp.aiter_lines():
                            if not line.strip():
                                continue
                            try:
                                data = json.loads(line)
                                if "content" in data['message']:
                                    yield data['message']["content"]
                            except json.JSONDecodeError:
                                continue
                except httpx.HTTPError as e:
                    print(f"Ollama stream error: {e}")
                    yield f"An error occurred with the LLM service: {e}"

        return Response(generate(), content_type="text/plain")
    except Exception as e:
        print(f"Story generation error: {e}")
        return jsonify({"error": "An internal server error occurred."}), 500


@app.post("/tts_stream")
async def tts_stream():
    """
    Async low-latency TTS using kokoro-onnx.
    Streams raw little-endian float32 PCM. First bytes contain "SR:<rate>\\n".
    """
    if kokoro is None:
        return jsonify({"error": "Text-to-speech service is not available."}), 503

    try:
        data = await request.get_json()
        text = (data or {}).get("text", "")
        voice = (data or {}).get("voice", VOICE)

        if not text:
            return jsonify({"error": "Text cannot be empty."}), 400

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
    except Exception as e:
        print(f"TTS stream error: {e}")
        return jsonify({"error": "An error occurred during TTS streaming."}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)