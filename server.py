import numpy as np
import tempfile
import logging
import uuid
import json
import httpx
import os
import re
from datetime import datetime
import asyncio
from quart import Quart, request, Response, jsonify
from kokoro_onnx import Kokoro
from config import KOKORO_MODEL, KOKORO_VOICES, OLLAMA_URL, LLM_MODEL, VOICE

# Import whisper only once
import whisper

# A simple in-memory cache for ongoing story generation jobs
story_jobs = {}

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)-8s %(message)s',
    #filename="logger.log",
    level=logging.DEBUG,
    datefmt='%Y-%m-%d %H:%M:%S')

logger=logging.getLogger('server')

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

# Ensure the 'stories' directory exists
STORIES_DIR = "stories"
if not os.path.exists(STORIES_DIR):
    os.makedirs(STORIES_DIR)

@app.route("/stt", methods=["POST"])
async def transcribe_audio():
    """Convert uploaded WAV to text using Whisper."""
    if stt_model is None:
        return jsonify({"error": "Speech-to-text service is not available."}), 503

    files = await request.files
    if "audio" not in files:
        return jsonify({"error": "No audio file provided."}), 400

    audio_file = files["audio"]

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
        logger.warning(f"Error during transcription: {e}")
        return jsonify({"error": "An error occurred during transcription."}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path) # Clean up the temporary file

@app.route("/")
async def index():
    return await app.send_static_file("index.html")

@app.route("/static/<path:path>")
async def serve_static(path):
    return await app.send_static_file(f"static/{path}")

# New endpoint to START the generation process
@app.post("/start_story_generation")
async def start_story_generation():
    payload = await request.get_json()
    messages = (payload or {}).get("messages", [])
    if not messages:
        return jsonify({"error": "Message history cannot be empty."}), 400

    job_id = str(uuid.uuid4())
    story_jobs[job_id] = {
        "text": "",
        "status": "in_progress",
    }
    
    # Run the generation in the background
    asyncio.create_task(generate_in_background(job_id, messages))
    
    return jsonify({"job_id": job_id})

# A separate async function to handle the long-running task
async def generate_in_background(job_id, messages):
    try:
        timeout_config = httpx.Timeout(600.0, connect=60.0)
        async with httpx.AsyncClient(timeout=timeout_config) as client:
            async with client.stream(
                "POST", OLLAMA_URL,
                json={"model": LLM_MODEL, "messages": messages, "stream": True}
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.strip():
                        try:
                            data = json.loads(line)
                            if "content" in data["message"]:
                                content_chunk = data["message"]["content"].replace('*', '')
                                # Append the new chunk to the job's text
                                story_jobs[job_id]["text"] += content_chunk
                        except (json.JSONDecodeError, KeyError):
                            continue
    except Exception as e:
        print(f"Background generation failed for job {job_id}: {e}")
        story_jobs[job_id]["status"] = "error"
    finally:
        story_jobs[job_id]["status"] = "complete"

# New endpoint for the client to poll for updates
@app.get("/get_story_chunk/<job_id>")
async def get_story_chunk(job_id):
    job = story_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found."}), 404

    current_text = job["text"]
    status = job["status"]
    
    # Clean up completed jobs to prevent memory leaks
    if status == "complete":
        del story_jobs[job_id]

    return jsonify({
        "text": current_text,
        "status": status,
    })

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
        text = (data or {}).get("text", "").replace("*","")
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

def sanitize_filename(title):
    """Sanitizes a string to be used as a filename."""
    # Replace spaces with underscores and remove non-alphanumeric characters
    sanitized = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')
    # Limit to first 30 characters to avoid very long filenames
    return sanitized[:30].strip('_')


@app.route("/save_story", methods=["POST"])
async def save_story():
    """Saves the chat history and story to a JSON file."""
    try:
        payload = await request.get_json()
        title = payload.get("title", "Untitled").strip()
        messages = payload.get("messages", [])
        story_text = payload.get("story_text", "")
        
        if not title or not story_text:
            return jsonify({"error": "Title and story content are required."}), 400

        # Create a sanitized filename from the title and a timestamp
        sanitized_title = sanitize_filename(title)
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = f"{sanitized_title}_{timestamp}.json"
        filepath = os.path.join(STORIES_DIR, filename)

        data_to_save = {
            "title": title,
            "timestamp": timestamp,
            "chat_history": messages,
            "story": story_text
        }

        with open(filepath, "w") as f:
            json.dump(data_to_save, f, indent=4)
        
        return jsonify({"message": "Story saved successfully!", "filename": filename})

    except Exception as e:
        print(f"Error saving story: {e}")
        return jsonify({"error": "An internal server error occurred while saving."}), 500


@app.route("/load_story/<filename>", methods=["GET"])
async def load_story(filename):
    """Loads a story from a JSON file."""
    filepath = os.path.join(STORIES_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "Story not found."}), 404
    
    try:
        with open(filepath, "r") as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        print(f"Error loading story: {e}")
        return jsonify({"error": "An error occurred while loading the story."}), 500


@app.route("/list_stories", methods=["GET"])
async def list_stories():
    """Lists all available story files and their titles."""
    try:
        files_with_titles = []
        for filename in os.listdir(STORIES_DIR):
            if filename.endswith(".json"):
                filepath = os.path.join(STORIES_DIR, filename)
                try:
                    with open(filepath, "r") as f:
                        data = json.load(f)
                        files_with_titles.append({
                            "filename": filename,
                            "title": data.get("title", os.path.splitext(filename)[0]),
                            "timestamp": data.get("timestamp", "")
                        })
                except (json.JSONDecodeError, FileNotFoundError):
                    continue
        
        # Sort by timestamp, newest first
        files_with_titles.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        
        return jsonify({"stories": files_with_titles})
    except Exception as e:
        print(f"Error listing stories: {e}")
        return jsonify({"error": "An error occurred while listing stories."}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
