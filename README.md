# simple-ai-story-builder
In order to do some testing with GPT5.0, I decided to tie a few ai technologies together into a very simple story builder app.  These scripts are intended for local use and rely on your computer being able to run basic lightweight LLM and other Text-To-Speech (TTS) and Speech-To-Text (STT) models.  FWIW this built using an M1 macbook, so your mileage may vary.  

A few words on GPT5.0, overall it was *not* a great experience.  Having never 'vibe' coded before, I was expecting it to at least keep track of the project but it consistently spit out semi working pieces of code which I had to piece together myself to get something only partially working.  Eventually, I decided to try Gemini (Google), which I had heard was overall a better coding experience.  I found this to be 100% true.. After feeding it the three main files in this project, it immediately was able to clean up several errors.  It was then able to add additional features without screwing up any of the previous code.  Short your openai stock, I think Google will win this.

## Details

This is a **voice-driven storytelling web app** that lets you:
- **Record your voice** using openai-whisper convert speech → text (STT).
- **Generate a story** from your spoken or typed prompt using the local Ollama API.
- **Read the story aloud** using Kokoro TTS with low-latency streaming audio.

The app streams **raw Float32 PCM audio** from Kokoro to the browser and plays it in real time, with built-in resampling to match the browser’s sample rate.

---

## ✨ Features

- 🎤 **Speech-to-Text (STT)**: Record voice in the browser, transcribe on the server.
- 📖 **Story Generation**: Uses the local Ollama API to generate stories from prompts.
- 🔊 **Low-Latency TTS**: Kokoro TTS streams audio as it’s generated for immediate playback.
- 🖊 **Editable Textboxes**: Edit the generated story before reading it aloud.
- 🔄 **Automatic Resampling**: Prevents “chipmunk” or slow audio playback by matching server & browser sample rates.

---

## 📂 Project Structure
```
project/
│
├── server.py # Quart (or Flask) backend server
├── static/
│ ├── story.js # Frontend JavaScript logic
│ └── index.html # Web UI
└── README.md # This file
```
---

## ⚙️ Requirements

- Python 3.9+
- Web browser (frontend runs in browser)
- [Ollama](https://ollama.ai/) installed and running locally
- [kokoro-onnx](https://github.com/hexgrad/kokoro-onnx) installed
- Whisper or another STT backend (modify `/stt` route in `server.py` to match your STT setup)

### Python dependencies
Install dependencies with:

```bash
pip install quart numpy soundfile httpx kokoro-onnx
```

### 🚀 Running the App
- download all necessary models
```bash
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```
- make sure ollama server is running locally
```bash
ollama serve
```
- add an appropriate story LLM to ollama
```bash
ollama pull https://huggingface.co/QuantFactory/gemma-2-Ifable-9B-GGUF
```
- build virtual environment of your choice e.g.
```bash
python3 -mvenv venv
source venv/bin/activate
pip install -r requirements.txt
```
- run the app
```bash
python server.py
```
- open the app
Visit http://localhost:8000 in your browser.

