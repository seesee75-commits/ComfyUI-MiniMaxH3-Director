"""Media I/O + HTTP endpoints for the MiniMax H3 Director timeline editor.

Contains code derived from the LTX Director node by WhatDreamsCost (GPL-3.0, see
LICENSE), via the CS fork by CGlide; modified in 2026 for MiniMax H3. The timeline UI
behaves identically on purpose: same chunked upload path, same waveform peaks, same
workspace folder, same drag-and-drop handling. Route paths are namespaced under
/minimax_director* so both nodes can be installed side by side.

The upload workspace stays `input/whatdreamscost` on purpose — assets dropped into
either Director are then visible to both.
"""

import asyncio
import base64
import io as _io
import json
import logging
import math
import os
import platform
import subprocess
import wave

import av
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths
from aiohttp import web
from server import PromptServer

log = logging.getLogger(__name__)

WORKSPACE_SUBDIR = "whatdreamscost"
AUDIO_SR = 44100


# --------------------------------------------------------------------------------------
# path helpers
# --------------------------------------------------------------------------------------

def resolve_input_path(rel_name: str):
    """Resolve a timeline file reference to an absolute path inside ComfyUI/input."""
    if not rel_name:
        return None
    input_dir = folder_paths.get_input_directory()
    candidates = [
        os.path.join(input_dir, rel_name),
        os.path.join(input_dir, WORKSPACE_SUBDIR, os.path.basename(rel_name)),
        os.path.join(input_dir, os.path.basename(rel_name)),
    ]
    for path in candidates:
        if os.path.exists(path) and os.path.isfile(path):
            return path
    return None


# --------------------------------------------------------------------------------------
# waveform peaks / audio extraction (timeline UI)
# --------------------------------------------------------------------------------------

def _peaks_from_int16(samples, num_peaks=200):
    peaks = []
    step = max(1, len(samples) // num_peaks)
    for i in range(num_peaks):
        chunk = samples[i * step:(i + 1) * step]
        peaks.append(float(np.max(np.abs(chunk)) / 32767.0) if len(chunk) else 0.0)
    return peaks


def read_wav_peaks(wav_path):
    with wave.open(wav_path, "rb") as w:
        n_frames = w.getnframes()
        if n_frames <= 0:
            return [0.0] * 200
        samples = np.frombuffer(w.readframes(n_frames), dtype=np.int16)
    return _peaks_from_int16(samples)


def _decode_to_int16_mono(container, rate):
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
    audio_bytes = bytearray()
    for frame in container.decode(stream):
        for out in resampler.resample(frame):
            audio_bytes.extend(out.to_ndarray().tobytes())
    for out in resampler.resample(None):
        audio_bytes.extend(out.to_ndarray().tobytes())
    return audio_bytes


def extract_audio_from_video(video_path):
    """Write a mono 44.1 kHz WAV next to the video and return (relative path, peaks)."""
    try:
        base, _ = os.path.splitext(video_path)
        output_wav = base + "_extracted_audio.wav"

        if os.path.exists(output_wav) and os.path.getsize(output_wav) > 44:
            try:
                with wave.open(output_wav, "rb") as w_check:
                    if w_check.getframerate() == AUDIO_SR:
                        peaks = read_wav_peaks(output_wav)
                        rel = os.path.relpath(output_wav, folder_paths.get_input_directory())
                        return rel.replace("\\", "/"), peaks
            except Exception:
                pass

        with av.open(video_path) as container:
            if not container.streams.audio:
                return None, None
            audio_bytes = _decode_to_int16_mono(container, AUDIO_SR)
            if not audio_bytes:
                return None, None
            with wave.open(output_wav, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(AUDIO_SR)
                w.writeframes(audio_bytes)

        peaks = _peaks_from_int16(np.frombuffer(audio_bytes, dtype=np.int16))
        rel = os.path.relpath(output_wav, folder_paths.get_input_directory())
        return rel.replace("\\", "/"), peaks
    except Exception as e:
        log.warning("[MiniMaxDirector] Server audio extraction failed: %s", e)
        return None, None


def get_audio_peaks(audio_path):
    if os.path.splitext(audio_path)[1].lower() == ".wav":
        try:
            return read_wav_peaks(audio_path)
        except Exception:
            pass
    try:
        with av.open(audio_path) as container:
            if not container.streams.audio:
                return None
            audio_bytes = _decode_to_int16_mono(container, 8000)
        if not audio_bytes:
            return None
        return _peaks_from_int16(np.frombuffer(audio_bytes, dtype=np.int16))
    except Exception as e:
        log.warning("[MiniMaxDirector] Failed to get audio peaks via PyAV: %s", e)
        return None


# --------------------------------------------------------------------------------------
# HTTP endpoints used by the timeline editor
# --------------------------------------------------------------------------------------

@PromptServer.instance.routes.get("/minimax_director_check_file")
async def minimax_director_check_file(request):
    """Dedupe uploads: report whether an identically named (and sized) file already exists."""
    filename = request.query.get("filename", "")
    file_size = request.query.get("size", "")
    if not filename:
        return web.json_response({"exists": False})

    upload_dir = folder_paths.get_input_directory()
    temp_dir = os.path.join(upload_dir, WORKSPACE_SUBDIR)

    def _matches(path):
        if not (os.path.exists(path) and os.path.isfile(path)):
            return False
        if not file_size:
            return True
        try:
            return os.path.getsize(path) == int(file_size)
        except ValueError:
            return True

    for path in (os.path.join(temp_dir, filename), os.path.join(upload_dir, filename)):
        if _matches(path):
            rel = os.path.relpath(path, upload_dir).replace("\\", "/")
            return web.json_response({"exists": True, "name": rel})

    base_name = os.path.basename(filename)
    suffix = "_" + base_name
    try:
        for search_dir in (temp_dir, upload_dir):
            if not os.path.exists(search_dir):
                continue
            for f_name in os.listdir(search_dir):
                if f_name.endswith(suffix) or f_name == base_name:
                    path = os.path.join(search_dir, f_name)
                    if _matches(path):
                        rel = os.path.relpath(path, upload_dir).replace("\\", "/")
                        return web.json_response({"exists": True, "name": rel})
    except Exception as e:
        log.warning("[MiniMaxDirector] Error listing input directory: %s", e)

    return web.json_response({"exists": False})


@PromptServer.instance.routes.post("/minimax_director/compile_prompt")
async def compile_prompt_endpoint(request):
    """Live prompt preview for the editor.

    Runs the very same planner the Director runs, so what the panel shows is what the
    model gets. Metadata only — no image, video or audio is decoded, so it stays instant
    no matter how much is on the timeline.
    """
    from . import minimax_plan as plan
    try:
        data = await request.json()
        fps = float(data.get("frame_rate") or 24.0) or 24.0
        tdata = plan.parse_timeline(data.get("timeline_data") or "")

        win_start = int(float(data.get("start_frame") or 0))
        duration_frames = max(1, int(float(data.get("duration_frames") or 1)))
        retake = plan.retake_state(tdata)
        if retake:
            win_start, duration_frames = retake["start"], retake["length"]

        p = plan.plan_timeline(
            tdata, win_start, duration_frames, fps,
            global_prompt=data.get("global_prompt") or "",
            use_custom_motion=bool(data.get("use_custom_motion", True)),
            use_custom_audio=bool(data.get("use_custom_audio", False)),
            override_audio=bool(data.get("override_audio", False)),
            extra_ref_image_count=int(data.get("extra_ref_image_count") or 0),
            ref_image_notes=data.get("ref_image_notes") or "",
        )

        warnings = []
        if p.get("prompt_overridden"):
            warnings.append("This prompt is hand-written. Timeline edits no longer change "
                            "it — they still decide which references are loaded.")
        if p["prompt_is_fallback"]:
            warnings.append("No prompt text on the timeline — 'video' would be sent.")
        if p["length"] > plan.TRAINED_MAX_FRAMES:
            # the model card's envelope, not a cap this node enforces (issue #12)
            warnings.append("%.1fs is past H3's trained range (the model card's 4-15s). It "
                            "renders, but expect drift or looping, and a render time that "
                            "climbs faster than the length." % p["actual_seconds"])
        anchored = [e for e in p["events"] if e.get("anchor_frame") is not None]
        clip_anchors = (p.get("video_anchors") or []) + (p.get("audio_anchors") or [])
        if anchored or clip_anchors:
            # The preview must never promise an anchor the render will drop, so it asks the
            # same question the node does — of the same core module, cached after the first
            # call. Guarded because this endpoint otherwise touches nothing but the planner,
            # and an install that cannot answer should still get its prompt.
            try:
                from . import minimax_core
                have_guide = minimax_core.add_guide() is not None
            except Exception:
                have_guide = True
            if not have_guide:
                warnings.append(
                    "%d image(s) or clip(s) would be anchored, which needs ComfyUI 0.34.0 "
                    "and its 'Add Guide for MiniMax H3' node. They are ignored: update "
                    "ComfyUI, or set them back to references."
                    % (len(anchored) + len(clip_anchors)))
        if p["ref_mode_on"] and len(p["ref_image_slots"]) >= plan.MAX_REF_IMAGES:
            warnings.append("Reference images are capped at %d." % plan.MAX_REF_IMAGES)
        # The batch on the ref_images socket only exists once the graph runs, so the
        # preview cannot number around it. Say so: the alternative is a prompt that shows
        # <Picture 2> where the render will send <Picture 5>, with nothing to explain why.
        if (p["ref_mode_on"] and bool(data.get("ref_images_connected"))
                and not int(data.get("extra_ref_image_count") or 0)):
            warnings.append(
                "Images on the ref_images socket are not counted here — every <Picture i> "
                "below shifts up by that batch size when you render.")
        warnings.extend(p.get("ref_warnings") or [])

        return web.json_response({
            "status": "success",
            "prompt": p["prompt"],
            "mode": p["mode"] + (" (retake)" if retake else ""),
            "format": p.get("prompt_format"),
            "shots": len(p["shots"]),
            "length": p["length"],
            "seconds": round(p["actual_seconds"], 2),
            # shown in the badge rather than warned about: the guide's 350-500 is a lot of
            # words for a 5-15s clip, so being under it is the ordinary state here
            "words": p.get("description_words") or 0,
            "refs": {"images": len(p["ref_image_slots"]),
                     "videos": len(p["ref_video_segs"]),
                     "audios": len(p["ref_audio_segs"])},
            # slot -> <Subject N>, so the editor's "Voice of" menu can name subjects the way
            # the prompt does instead of counting slots and getting a different answer
            "subject_of_slot": {str(k): v for k, v in
                                (p.get("subject_of_slot") or {}).items()},
            # segment id -> the output frame it is anchored at, so the canvas can say where
            # each one lands. The conversion stays here with the planner: a second copy of
            # it in the editor is exactly the drift this endpoint exists to prevent.
            "anchors": {str(a["seg"].get("id")): a["anchor_frame"]
                        for a in anchored + clip_anchors if a["seg"].get("id")},
            "anchor_fps": plan.MODEL_FPS,
            "overridden": bool(p.get("prompt_overridden")),
            # what the timeline would produce, so the panel can offer it back without
            # having to recompile behind the user's back
            "compiled": p.get("compiled_prompt", p["prompt"]),
            "warnings": warnings,
        })
    except Exception as e:
        log.warning("[MiniMaxDirector] compile_prompt failed: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@PromptServer.instance.routes.post("/minimax_director/probe_video")
async def probe_video_endpoint(request):
    """Duration, size and a first frame for a video the browser could not open.

    The editor builds a reference-video segment from a local blob: it needs the duration
    to size the clip on the timeline and a frame for the thumbnail. That path goes through
    a <video> element, so it only works for what the browser can decode — and a browser
    decodes far less than the renderer does. HEVC, ProRes and 10-bit footage inside a
    perfectly ordinary .mp4 or .mov are all refused by Chrome and all read fine here,
    because PyAV is what loads reference videos at generation time anyway.

    Without this the editor silently rejected files it would have rendered without
    complaint. The codec is reported back so a failure can at least name itself.
    """
    try:
        data = await request.json()
        path = resolve_input_path(data.get("file") or "")
        if not path:
            return web.json_response({"status": "error",
                                      "message": "File not found on the server."})

        with av.open(path) as container:
            if not container.streams.video:
                return web.json_response({"status": "error",
                                          "message": "No video stream in that file."})
            stream = container.streams.video[0]
            codec = getattr(stream.codec_context, "name", "") or ""
            width = stream.width or stream.codec_context.width or 0
            height = stream.height or stream.codec_context.height or 0

            # Container duration first — a stream's own is missing often enough to matter.
            duration = 0.0
            if container.duration:
                duration = float(container.duration) / av.time_base
            elif stream.duration and stream.time_base:
                duration = float(stream.duration * stream.time_base)

            rate = stream.average_rate or stream.guessed_rate
            fps = float(rate) if rate else 0.0

            # Some containers report no duration at all. Frame count over rate is the
            # fallback, and it has to be read while the container is still open.
            if duration <= 0 and fps > 0 and stream.frames:
                duration = float(stream.frames) / fps

            thumb = ""
            try:
                frame = next(container.decode(video=0), None)
                if frame is not None:
                    image = frame.to_image()
                    image.thumbnail((512, 512))
                    buffer = _io.BytesIO()
                    image.convert("RGB").save(buffer, format="JPEG", quality=90)
                    thumb = "data:image/jpeg;base64," + \
                        base64.b64encode(buffer.getvalue()).decode("ascii")
            except Exception as e:
                # a thumbnail is a nicety; the clip is still usable without one
                log.debug("[MiniMaxDirector] probe thumbnail failed for %s: %s", path, e)

        log.info("[MiniMaxDirector] probed '%s': %s %dx%d, %.2fs @ %.2f fps",
                 os.path.basename(path), codec or "unknown", width, height, duration, fps)
        return web.json_response({"status": "success", "duration": round(duration, 3),
                                  "fps": round(fps, 4), "width": width, "height": height,
                                  "codec": codec, "thumb": thumb})
    except Exception as e:
        log.warning("[MiniMaxDirector] probe_video failed: %s", e)
        return web.json_response({"status": "error", "message": str(e)})


@PromptServer.instance.routes.get("/minimax_director_get_audio")
async def minimax_director_get_audio(request):
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"error": "Missing filename"}, status=400)

    file_path = resolve_input_path(filename.replace("\\", "/"))
    if not file_path:
        return web.json_response({"error": "File not found"}, status=404)

    upload_dir = folder_paths.get_input_directory()
    if os.path.splitext(file_path)[1].lower() in (".wav", ".mp3", ".ogg", ".flac", ".m4a"):
        peaks = None
        try:
            peaks = get_audio_peaks(file_path)
        except Exception as e:
            log.warning("[MiniMaxDirector] Failed to get audio peaks: %s", e)
        rel = os.path.relpath(file_path, upload_dir).replace("\\", "/")
        return web.json_response({"audio_file": rel, "peaks": peaks})

    audio_file, peaks = None, None
    try:
        loop = asyncio.get_event_loop()
        audio_file, peaks = await loop.run_in_executor(None, extract_audio_from_video, file_path)
    except Exception as e:
        log.warning("[MiniMaxDirector] Error extracting audio: %s", e)
    return web.json_response({"audio_file": audio_file, "peaks": peaks})


@PromptServer.instance.routes.get("/minimax_director_open_folder")
async def minimax_director_open_folder(request):
    upload_dir = os.path.join(folder_paths.get_input_directory(), WORKSPACE_SUBDIR)
    os.makedirs(upload_dir, exist_ok=True)
    try:
        system = platform.system()
        if system == "Windows":
            subprocess.Popen(["explorer", os.path.normpath(upload_dir)])
        elif system == "Darwin":
            subprocess.Popen(["open", upload_dir])
        else:
            subprocess.Popen(["xdg-open", upload_dir])
        return web.json_response({"success": True})
    except Exception as e:
        log.warning("[MiniMaxDirector] Failed to open workspace folder: %s", e)
        return web.json_response({"success": False, "error": str(e)}, status=500)


def _write_chunk(file, file_path, mode):
    with open(file_path, mode) as f:
        f.write(file.file.read())


@PromptServer.instance.routes.post("/minimax_director_upload_chunk")
async def minimax_director_upload_chunk(request):
    """Chunked upload — sidesteps the 413 Payload Too Large limit on big videos."""
    post = await request.post()
    file = post.get("file")
    filename = os.path.basename(post.get("filename"))
    chunk_index = int(post.get("chunk_index"))
    total_chunks = int(post.get("total_chunks"))

    upload_dir = os.path.join(folder_paths.get_input_directory(), WORKSPACE_SUBDIR)
    os.makedirs(upload_dir, exist_ok=True)
    file_path = os.path.join(upload_dir, filename)

    if not os.path.realpath(file_path).startswith(os.path.realpath(upload_dir)):
        return web.json_response({"error": "Invalid filename"}, status=400)

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _write_chunk, file, file_path, "ab" if chunk_index > 0 else "wb")

    if chunk_index == total_chunks - 1:
        audio_file, peaks = None, None
        try:
            audio_file, peaks = await loop.run_in_executor(None, extract_audio_from_video, file_path)
        except Exception as e:
            log.warning("[MiniMaxDirector] Error in final chunk audio extraction: %s", e)
        return web.json_response({
            "name": "%s/%s" % (WORKSPACE_SUBDIR, filename),
            "audio_file": audio_file,
            "peaks": peaks,
        })
    return web.json_response({"status": "ok"})


# --------------------------------------------------------------------------------------
# VLM character analysis (Ollama / LM Studio / OpenAI-compatible)
# --------------------------------------------------------------------------------------

_PROVIDER_DEFAULTS = {
    # Any vision model Ollama can serve works; this one is only the pre-filled suggestion.
    "ollama": {"url": "http://127.0.0.1:11434", "model": "qwen2.5vl:7b"},
    "lmstudio": {"url": "http://127.0.0.1:1234", "model": ""},
    "custom": {"url": "", "model": ""},
}

# What to look at, per subject kind. A slot is not necessarily a character — the reference
# guide's <Subject N> covers scenes, props, styles and poses too — and asking for hair and
# clothing when the image is a coffee shop produced exactly the answer you would expect.
_ANALYZE_SUBJECT = {
    "person": ("person", "hair colour and style, face, build, and clothing type and colour"),
    "animal": ("animal", "species, markings, coat, and build"),
    "object": ("object", "shape, material, colour, and any markings"),
    "environment": ("place", "architecture, furnishing, materials, and lighting"),
    "clothing": ("garment", "cut, colour, material, and fastenings"),
    "prop": ("prop", "shape, material, colour, and signs of wear"),
    "interface": ("interface", "layout, typography, iconography, and colour"),
    "effect": ("visual effect", "shape, colour, motion, and how it interacts with the scene"),
    "style": ("visual style", "palette, contrast, grain, and grade"),
    "action": ("action", "the movement, its timing, and the body mechanics"),
    "expression": ("facial expression", "the eyes, mouth, and what it conveys"),
    "pose": ("pose", "posture, limb placement, and weight distribution"),
}


def analyze_prompt(kind):
    """Ask the vision model for the slot's two sentences, in labelled lines.

    Two answers, not one: `DESCRIPTION` becomes the `<Subject N>` definition and
    `RETAINED` becomes its retention_analysis line. They are different sentences in
    different sections — one says what the thing is, the other says what has to survive
    into the generated video — and the guide's own example writes both.
    """
    noun, look_for = _ANALYZE_SUBJECT.get(kind or "", _ANALYZE_SUBJECT["person"])
    return (
        "Look at the reference image(s) of this %s and answer in exactly two lines, "
        "using these labels and nothing else:\n"
        "DESCRIPTION: one concise sentence naming the %s.\n"
        "RETAINED: a short comma-separated list of the specific features that must stay "
        "identical in a generated video.\n"
        "Do not add any other text, headings or commentary."
        % (noun, look_for)
    )


def normalize_base_url(url, fallback=""):
    """Make a typed-in address usable.

    "127.0.0.1:11434" is what people actually enter, and aiohttp rejects it outright with
    NonHttpUrlClientError because it has no scheme. Assume http:// when none is given.
    """
    url = (url or "").strip().rstrip("/")
    if not url:
        return (fallback or "").strip().rstrip("/")
    if "://" not in url:
        url = "http://" + url
    return url


def chat_completions_url(base_url):
    """The chat endpoint for an OpenAI-compatible base address, with or without `/v1`.

    Providers document their base URL both ways (Anthropic and LM Studio include `/v1`),
    and appending `/v1/chat/completions` to one that already has it asks for `/v1/v1/...`
    and gets a 404 (issue #31).
    """
    root = base_url[:-3] if base_url.endswith("/v1") else base_url
    return "%s/v1/chat/completions" % root


def _resolve_provider(data):
    provider = (data.get("provider") or "ollama").lower()
    defs = _PROVIDER_DEFAULTS.get(provider, _PROVIDER_DEFAULTS["ollama"])
    base_url = normalize_base_url(data.get("base_url"), defs["url"])
    model = data.get("model") or defs["model"]
    return provider, base_url, model


# Env vars tried in order when nothing else supplies a key. The pack-specific one first so
# a cloud VLM here does not have to share a name with whatever else on the machine reads
# OPENAI_API_KEY.
API_KEY_ENV_VARS = ("MINIMAX_DIRECTOR_VLM_API_KEY", "OPENAI_API_KEY")


def resolve_api_key(data=None):
    """Find the bearer token for a cloud endpoint, without ever storing one in a workflow.

    A hosted OpenAI-compatible endpoint needs authentication, and until now nothing here
    sent any, so `custom` only ever reached a server on the local network (issue #15).

    Where a key may come from, in order:

    1. `api_key` in the request — the Director's gear menu, which keeps it in ComfyUI's
       user settings. **Not** in `timeline_data`: that is serialised into the workflow
       JSON, so a key typed there would travel with every workflow the user shares.
    2. the environment variable named in `api_key_env` — how a node widget asks for a key
       without carrying one, since widget values *are* saved with the workflow.
    3. MINIMAX_DIRECTOR_VLM_API_KEY, then OPENAI_API_KEY.

    Returns "" when there is nothing to send, which is the normal case for local Ollama
    and LM Studio.
    """
    data = data or {}
    key = (data.get("api_key") or "").strip()
    if key:
        return key
    named = (data.get("api_key_env") or "").strip()
    for var in ([named] if named else []) + list(API_KEY_ENV_VARS):
        value = (os.environ.get(var) or "").strip()
        if value:
            return value
    return ""


def _auth_headers(api_key):
    """Bearer header, or nothing at all — an empty Authorization is worse than none."""
    key = (api_key or "").strip()
    return {"Authorization": "Bearer %s" % key} if key else None


class VLMError(RuntimeError):
    """A VLM round-trip that failed with a message worth showing the user verbatim."""


def strip_thinking(text):
    """Drop a reasoning preamble. Models with the `thinking` capability emit one even
    when asked not to, and it must never reach the prompt."""
    text = (text or "").strip()
    if "</think>" in text:
        text = text.split("</think>")[-1].strip()
    elif text.startswith("<think>"):        # unterminated block: nothing usable survives
        text = ""
    return text


async def vlm_generate(images_b64, prompt, provider, base_url, model,
                       system_prompt=None, timeout=120, keep_alive=0, max_tokens=None,
                       api_key=None):
    """One vision-model round-trip, shared by the Analyze endpoint and the Enhance node.

    Kept provider-shaped rather than generic on purpose: Ollama takes raw base64 in an
    `images` array on /api/generate, everyone else takes data URLs in OpenAI message
    content on /v1/chat/completions.

    `keep_alive=0` makes Ollama drop the model right after answering, so it is not still
    holding VRAM when H3 starts sampling.

    `api_key` goes out as a bearer token on both paths — hosted Ollama and reverse proxies
    in front of a local server want one too, and an absent key sends no header at all.

    Raises VLMError with a user-facing message; returns the answer with any thinking
    preamble removed.
    """
    import aiohttp

    if provider in ("lmstudio", "custom") and not model:
        raise VLMError("No model name set for %s. Enter the name of the model you have "
                       "loaded there." % provider)

    headers = _auth_headers(api_key)

    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            if provider == "ollama":
                payload = {"model": model, "prompt": prompt, "images": images_b64,
                           "stream": False, "keep_alive": keep_alive,
                           # honoured by thinking-capable models; harmless on the rest
                           "think": False}
                if system_prompt:
                    payload["system"] = system_prompt
                if max_tokens:
                    # the only thing that actually stops a small model from rambling;
                    # asking for a word count in the prompt does not
                    payload["options"] = {"num_predict": int(max_tokens)}
                async with session.post("%s/api/generate" % base_url, json=payload,
                                        timeout=timeout) as response:
                    if response.status != 200:
                        raise VLMError("Ollama HTTP %s: %s" % (response.status, await response.text()))
                    body = await response.json()
                    text = ((body.get("response") or "").strip()
                            or (body.get("thinking") or "").strip())
            else:
                content = [{"type": "text", "text": prompt}]
                for b64 in images_b64:
                    content.append({"type": "image_url",
                                    "image_url": {"url": "data:image/jpeg;base64,%s" % b64}})
                messages = []
                if system_prompt:
                    messages.append({"role": "system", "content": system_prompt})
                messages.append({"role": "user", "content": content})
                payload = {"model": model, "messages": messages,
                           "max_tokens": int(max_tokens) if max_tokens else 2048,
                           "stream": False}
                async with session.post(chat_completions_url(base_url), json=payload,
                                        timeout=timeout) as response:
                    if response.status in (401, 403):
                        # the one HTTP status worth naming: the fix is somewhere else
                        # entirely, and the endpoint's own body rarely says where
                        raise VLMError(
                            "%s refused the request (HTTP %s)%s. Set an API key in the "
                            "Analyze settings, or put one in the %s environment variable."
                            % (provider, response.status,
                               "" if headers else " and no API key was sent",
                               API_KEY_ENV_VARS[0]))
                    if response.status != 200:
                        raise VLMError("%s HTTP %s: %s" % (provider, response.status, await response.text()))
                    resp_json = await response.json()
                    try:
                        msg = resp_json["choices"][0]["message"]
                        text = (msg.get("content") or "").strip()
                        if not text:
                            # thinking models leave content empty
                            text = (msg.get("reasoning_content") or "").strip()
                    except (KeyError, IndexError, TypeError):
                        raise VLMError("Unexpected response shape from %s." % provider)
    except aiohttp.ClientConnectorError:
        raise VLMError("Could not connect to %s at %s. Make sure the server is running."
                       % (provider, base_url))
    except (aiohttp.ServerTimeoutError, asyncio.TimeoutError):
        raise VLMError("%s did not answer within %ss." % (provider, timeout))
    except aiohttp.InvalidURL:
        raise VLMError("'%s' is not a usable address for %s." % (base_url, provider))
    except VLMError:
        raise
    except Exception as e:
        # Everything reaching a caller has to be a VLMError, or the node's passthrough
        # guard cannot catch it and a typo in the URL takes the whole run down.
        raise VLMError("%s: %s: %s" % (provider, type(e).__name__, e))

    return strip_thinking(text)


@PromptServer.instance.routes.post("/minimax_director/analyze_character")
async def analyze_character_endpoint(request):
    try:
        from . import minimax_plan as plan
        data = await request.json()
        image_b64 = data.get("image_b64", "")
        char_index = int(data.get("char_index", 0))
        kind = plan.sanitize_kind(data.get("kind"))
        provider, base_url, model_name = _resolve_provider(data)
        api_key = resolve_api_key(data)

        if provider == "off":
            return web.json_response({"status": "error", "message": "Analyze is set to Off / Manual."})
        if not image_b64:
            return web.json_response({"status": "error", "message": "No image provided for analysis."})

        b64_list = image_b64 if isinstance(image_b64, list) else [image_b64]
        cleaned = [b.split(",", 1)[1] if "," in b else b for b in b64_list]
        if not cleaned:
            return web.json_response({"status": "error", "message": "No valid base64 images decoded."})

        # the key itself is never logged, only whether one is going out
        log.info("[MiniMaxDirector] Analyzing reference slot %d (%s) via %s (%s, model "
                 "'%s'%s)...", char_index + 1, kind, provider, base_url, model_name,
                 ", authenticated" if api_key else "")
        try:
            generated_text = await vlm_generate(cleaned, analyze_prompt(kind), provider,
                                                base_url, model_name, api_key=api_key)
        except VLMError as e:
            return web.json_response({"status": "error", "message": str(e)})

        description, retained = plan.split_analysis(generated_text)
        log.info("[MiniMaxDirector] Analysis complete: %s", generated_text)
        return web.json_response({"status": "success", "description": description,
                                  "retention_note": retained})
    except Exception as e:
        log.error("[MiniMaxDirector] Failed to analyze character: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def unload_model(provider, base_url, model, api_key=None):
    """Evict the model from VRAM. Never raises — freeing memory must not fail a render.

    Two servers can be asked, by two different protocols:

    * **Ollama** takes `keep_alive: 0` on a generate call. The generate request already
      carries it, but asking again is cheap and covers the cases where it did not take —
      a call that errored before the option was honoured, or a server with its own TTL.
    * **llama.cpp in router mode** has `POST /models/unload` with `{"model": id}`, and
      `GET /models` reporting `status: loaded|unloaded` per model. A plain
      `llama-server -m model.gguf` has neither; there the answer is its own
      `--sleep-idle-seconds`, which nothing here can set remotely.

    LM Studio manages residency itself and exposes no unload over HTTP.

    `api_key` is carried through for the same reason the generate call carries it: a
    server that needs a bearer token to answer needs one to be told to unload as well.
    """
    if not model:
        return False
    try:
        import aiohttp
    except Exception:
        return False

    headers = _auth_headers(api_key)

    if provider == "ollama":
        try:
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.post("%s/api/generate" % base_url,
                                        json={"model": model, "keep_alive": 0},
                                        timeout=10) as response:
                    await response.text()
            log.info("[MiniMaxDirector] asked Ollama to release '%s'.", model)
            return True
        except Exception as e:
            log.debug("[MiniMaxDirector] could not unload '%s': %s", model, e)
            return False

    # Anything else: try the llama.cpp router, and say plainly when it is not there rather
    # than leaving a checkbox that quietly does nothing (issue #9).
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.post("%s/models/unload" % base_url,
                                    json={"model": model}, timeout=10) as response:
                body = await response.text()
                if response.status < 400:
                    log.info("[MiniMaxDirector] asked the llama.cpp router to unload '%s'.",
                             model)
                    return True
                if response.status in (404, 501):
                    log.info(
                        "[MiniMaxDirector] %s at %s has no /models/unload, so '%s' stays "
                        "loaded while H3 samples. That endpoint only exists when llama-server "
                        "runs in router mode; a plain one can unload itself with "
                        "--sleep-idle-seconds N instead.", provider, base_url, model)
                    return False
                log.debug("[MiniMaxDirector] /models/unload returned %s: %s",
                          response.status, body[:200])
                return False
    except Exception as e:
        log.debug("[MiniMaxDirector] could not reach %s to unload '%s': %s",
                  base_url, model, e)
        return False


@PromptServer.instance.routes.post("/minimax_director/unload_ollama")
async def unload_ollama_endpoint(request):
    """Evict the analysis VLM from VRAM right before a run so it doesn't fight H3 for memory."""
    try:
        try:
            data = await request.json()
        except Exception:
            data = {}
        provider, base_url, model_name = _resolve_provider(data)
        # one code path for every provider, so the gear menu and the Enhance node cannot
        # disagree about what "unload" means
        freed = await unload_model(provider, base_url, model_name, resolve_api_key(data))
        return web.json_response({
            "status": "ok", "provider": provider, "released": freed,
            "note": "" if freed else "server exposes no unload — give it its own idle timeout",
        })
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


# --------------------------------------------------------------------------------------
# tensor loading
# --------------------------------------------------------------------------------------

BLANK = lambda: torch.zeros((1, 512, 512, 3), dtype=torch.float32)


def _pil_to_tensor(img):
    arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def load_image_source(b64_or_url: str, filename: str = None) -> torch.Tensor:
    """Load a reference image from base64, a Comfy /view URL, or an input-relative name."""
    if not b64_or_url and not filename:
        return BLANK()

    if b64_or_url and "view?" in b64_or_url:
        try:
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(b64_or_url).query)
            fname = q.get("filename", [None])[0]
            subfolder = q.get("subfolder", [""])[0]
            if fname:
                path = os.path.join(folder_paths.get_input_directory(), subfolder, fname)
                if os.path.exists(path):
                    return _pil_to_tensor(Image.open(path))
        except Exception as e:
            log.debug("[MiniMaxDirector] URL parsing failed for %s: %s", b64_or_url, e)

    if filename:
        path = resolve_input_path(filename)
        if path:
            return _pil_to_tensor(Image.open(path))

    if b64_or_url:
        try:
            b64_str = b64_or_url.split(",", 1)[1] if "," in b64_or_url else b64_or_url
            return _pil_to_tensor(Image.open(_io.BytesIO(base64.b64decode(b64_str))))
        except Exception as e:
            log.debug("[MiniMaxDirector] Base64 decoding failed: %s", e)

    return BLANK()


def load_image_tensor(seg: dict) -> torch.Tensor:
    """Decode a timeline image segment to [1, H, W, 3] float32 in [0, 1]."""
    if seg.get("imageFile"):
        path = resolve_input_path(seg["imageFile"])
        if path:
            return _pil_to_tensor(Image.open(path))

    b64_str = seg.get("imageB64", "")
    if not b64_str or b64_str.startswith("/view?"):
        return BLANK()
    try:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        return _pil_to_tensor(Image.open(_io.BytesIO(base64.b64decode(b64_str))))
    except Exception:
        return BLANK()


def _decode_target_size(width, height, max_short_edge, max_pixels):
    """Aspect-preserving downscale bound: short edge <= max_short_edge and area <= max_pixels."""
    scale = min(1.0, max_short_edge / max(1, min(width, height)))
    if width * height * scale * scale > max_pixels:
        scale = math.sqrt(max_pixels / float(width * height))
    return max(16, int(round(width * scale)) // 2 * 2), max(16, int(round(height * scale)) // 2 * 2)


def load_video_tensor(file_ref: str, trim_start_sec: float, duration_sec: float,
                      out_fps: float = 24.0, max_short_edge: int = 768,
                      max_pixels: int = 768 * 1344) -> torch.Tensor:
    """Decode a clip and resample it to `out_fps`, returning [N, H, W, 3] float32.

    Frames are downscaled while decoding — a few seconds of 4K at full resolution would
    otherwise blow up RAM long before the VAE ever sees them.
    """
    path = resolve_input_path(file_ref)
    if not path:
        log.warning("[MiniMaxDirector] Video not found: %s", file_ref)
        return BLANK()

    n_out = max(1, int(round(duration_sec * out_fps)))
    targets = [trim_start_sec + i / out_fps for i in range(n_out)]

    frames = []
    try:
        with av.open(path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            src_w = stream.width or stream.codec_context.width
            src_h = stream.height or stream.codec_context.height
            dst_w, dst_h = _decode_target_size(src_w, src_h, max_short_edge, max_pixels)

            seek_target = max(0.0, trim_start_sec - 0.5)
            if stream.time_base:
                container.seek(int(seek_target / float(stream.time_base)), stream=stream, backward=True)
            else:
                container.seek(int(seek_target * av.time_base), stream=stream, backward=True)

            idx = 0
            prev = None
            for frame in container.decode(stream):
                ftime = frame.time
                if ftime is None and frame.pts is not None and stream.time_base:
                    ftime = float(frame.pts * stream.time_base)
                if ftime is None:
                    ftime = 0.0

                # emit every target timestamp this frame is the closest match for
                while idx < n_out and ftime >= targets[idx] - 1e-6:
                    pick = frame
                    if prev is not None and abs(prev[0] - targets[idx]) < abs(ftime - targets[idx]):
                        pick = prev[1]
                    frames.append(pick.reformat(width=dst_w, height=dst_h, format="rgb24").to_ndarray())
                    idx += 1
                prev = (ftime, frame)
                if idx >= n_out:
                    break

            # source ended early: hold the last frame so the clip still has its full length
            if frames and idx < n_out:
                frames.extend([frames[-1]] * (n_out - idx))
    except Exception as e:
        log.warning("[MiniMaxDirector] Video extract error for %s: %s", file_ref, e)

    if not frames:
        return BLANK()
    return torch.from_numpy(np.asarray(frames, dtype=np.float32) / 255.0)


def _decode_audio_stereo(buffer_or_path, target_sr=AUDIO_SR):
    """Decode anything PyAV reads into a [2, N] float32 tensor at target_sr."""
    blocks = []
    with av.open(buffer_or_path) as container:
        if not container.streams.audio:
            return None
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=target_sr)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                blocks.append(torch.from_numpy(out.to_ndarray()))
        for out in resampler.resample(None):
            blocks.append(torch.from_numpy(out.to_ndarray()))
    if not blocks:
        return None
    return torch.cat(blocks, dim=1)


def load_audio_segment(seg: dict, frame_rate: float, file_key: str = "audioFile"):
    """Load one timeline audio segment as a ComfyUI AUDIO dict, honouring its trim."""
    waveform = None
    if seg.get(file_key):
        path = resolve_input_path(seg[file_key])
        if path:
            try:
                waveform = _decode_audio_stereo(path)
            except Exception as e:
                log.warning("[MiniMaxDirector] Audio decode failed for %s: %s", seg.get(file_key), e)
        elif not seg.get("audioB64"):
            # A clip whose file has gone used to leave nothing behind at all: the caller drops it,
            # and with the prompt already written the <Audio N> labels then name references the
            # model never got.
            log.warning("[MiniMaxDirector] Audio clip '%s' is not in ComfyUI's input folder "
                        "(looked in it, in input/%s, and for the bare filename). The clip is on "
                        "the timeline but there is no file left to send — re-add it.",
                        seg[file_key], WORKSPACE_SUBDIR)
    if waveform is None and seg.get("audioB64"):
        try:
            b64 = seg["audioB64"]
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            waveform = _decode_audio_stereo(_io.BytesIO(base64.b64decode(b64)))
        except Exception as e:
            log.warning("[MiniMaxDirector] Audio base64 decode failed: %s", e)
    if waveform is None:
        return None

    start = int(float(seg.get("trimStart", 0)) / frame_rate * AUDIO_SR)
    length = int(float(seg.get("length", 1)) / frame_rate * AUDIO_SR)
    clip = waveform[:, max(0, start):max(0, start) + max(1, length)]
    if clip.shape[1] <= 0:
        # Not a missing file but timeline arithmetic: the trim starts past the end of the decoded
        # audio. Say which clip and with what numbers, or it looks like a clip never loaded.
        log.warning("[MiniMaxDirector] Audio clip '%s' came out empty: its trim starts at %.2fs "
                    "and the file decoded to %.2fs. Nothing to send — retrim the clip.",
                    seg.get("fileName") or seg.get(file_key),
                    float(seg.get("trimStart", 0)) / frame_rate, waveform.shape[1] / AUDIO_SR)
        return None
    return {"waveform": clip.unsqueeze(0), "sample_rate": AUDIO_SR}


# --------------------------------------------------------------------------------------
# image geometry
# --------------------------------------------------------------------------------------

def resize_image(tensor: torch.Tensor, target_w: int, target_h: int,
                 method: str, divisible_by: int) -> torch.Tensor:
    """Resize [N, H, W, 3] to the target, snapping the result to `divisible_by`."""
    def snap(val, div):
        return max(div, (int(val) // div) * div)

    def scaled(edge, ratio):
        # Round, don't truncate. A ratio that is exact in arithmetic comes back a hair under
        # its integer in floating point — 704 * (480 / 704) is 479.99999999999994 — and
        # int() then throws a whole pixel away. That pixel is not cosmetic: in the
        # cover-crop below it made `new_w` one short of the target, so the centre slice ran
        # from -1 and yielded a 1px-wide image (a 704x1408 timeline image fitted to 480x640
        # reached the Director's canvas guard as "the canvas came out 1x640"). In the
        # aspect-preserving branches it cost a whole 32-block: a 1920x1080 image in a 1024
        # box snapped to 992x544 instead of the 1024x576 this module's caller documents.
        return int(round(edge * ratio))

    tw, th = snap(target_w, divisible_by), snap(target_h, divisible_by)
    N, H, W, C = tensor.shape
    if H == th and W == tw:
        return tensor

    t = tensor.permute(0, 3, 1, 2)

    if method == "maintain aspect ratio":
        ratio = min(tw / W, th / H)
        out = F.interpolate(t, size=(snap(scaled(H, ratio), divisible_by), snap(scaled(W, ratio), divisible_by)),
                            mode="bilinear", align_corners=False)
    elif method in ("pad", "pad green"):
        ratio = min(tw / W, th / H)
        # min() with the box: the inner image is padded up to it, so an edge that came out
        # even a pixel over would turn F.pad's padding negative and crop instead.
        new_w, new_h = snap(min(tw, scaled(W, ratio)), divisible_by), snap(min(th, scaled(H, ratio)), divisible_by)
        inner = F.interpolate(t, size=(new_h, new_w), mode="bilinear", align_corners=False)
        pad_l, pad_t = (tw - new_w) // 2, (th - new_h) // 2
        if method == "pad green":
            out = torch.zeros((N, C, th, tw), dtype=t.dtype, device=t.device)
            out[:, 0], out[:, 1], out[:, 2] = 102 / 255.0, 1.0, 0.0
            out[:, :, pad_t:pad_t + new_h, pad_l:pad_l + new_w] = inner
        else:
            out = F.pad(inner, (pad_l, tw - new_w - pad_l, pad_t, th - new_h - pad_t),
                        mode="constant", value=0)
    elif method == "crop":
        ratio = max(tw / W, th / H)
        # max() with the box: a cover has to be at least the size it is covering, so the
        # centre slice below cannot start at a negative offset whatever the arithmetic does.
        new_w, new_h = max(tw, scaled(W, ratio)), max(th, scaled(H, ratio))
        inner = F.interpolate(t, size=(new_h, new_w), mode="bilinear", align_corners=False)
        left, top = (new_w - tw) // 2, (new_h - th) // 2
        out = inner[:, :, top:top + th, left:left + tw]
    else:  # "stretch to fit" and anything unknown
        out = F.interpolate(t, size=(th, tw), mode="bilinear", align_corners=False)

    return out.permute(0, 2, 3, 1)


def compress_image(tensor: torch.Tensor, crf: int) -> torch.Tensor:
    """Bake H.264 artefacts into [N, H, W, 3]; crf=0 is a no-op."""
    if crf <= 0:
        return tensor
    N, H, W, C = tensor.shape
    h, w = (H // 2) * 2, (W // 2) * 2
    frames = (tensor[:, :h, :w, :] * 255.0).byte().cpu().numpy()
    try:
        buf = _io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=24)
        stream.width, stream.height, stream.pix_fmt = w, h, "yuv420p"
        stream.options = {"crf": str(crf), "preset": "ultrafast"}
        for i in range(N):
            for pkt in stream.encode(av.VideoFrame.from_ndarray(frames[i], format="rgb24")):
                container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)
        container.close()

        buf.seek(0)
        reader = av.open(buf, mode="r")
        decoded = [f.to_ndarray(format="rgb24") for f in reader.decode(video=0)]
        reader.close()
        if not decoded:
            return tensor

        out = tensor.clone()
        n = min(N, len(decoded))
        out[:n, :h, :w] = torch.from_numpy(
            np.stack(decoded).astype(np.float32) / 255.0)[:n].to(tensor.device, tensor.dtype)
        return out
    except Exception as e:
        log.warning("[MiniMaxDirector] img_compression encode/decode failed: %s", e)
        return tensor


# --------------------------------------------------------------------------------------
# timeline audio mixdown
# --------------------------------------------------------------------------------------

def build_combined_audio(timeline_data_str: str, start_frame: int, duration_frames: int,
                         frame_rate: float, override_audio: bool = False, only=None) -> dict:
    """Mix the timeline's audio track down to one AUDIO dict covering the render window.

    `only` is a predicate over the clip's dict; given, it mixes just the clips it accepts
    — how the locked clips are lifted out of the same track the full mixdown comes from.
    """
    total_samples = max(1, int(math.ceil(duration_frames / frame_rate * AUDIO_SR)))
    empty = {"waveform": torch.zeros((1, 2, total_samples), dtype=torch.float32),
             "sample_rate": AUDIO_SR}

    if not timeline_data_str:
        return empty

    try:
        data = json.loads(timeline_data_str)
        if data.get("retakeMode") and data.get("retakeVideo"):
            rv = data["retakeVideo"]
            name = rv.get("imageFile") or rv.get("fileName")
            audio_segs = [{"videoFile": name, "audioFile": name, "start": 0,
                           "length": rv.get("videoDurationFrames", duration_frames), "trimStart": 0}]
            override_audio = True
        elif override_audio:
            audio_segs = data.get("motionSegments", [])
        else:
            audio_segs = data.get("audioSegments", [])
    except Exception:
        return empty

    if only is not None:
        audio_segs = [seg for seg in audio_segs if only(seg)]
    if not audio_segs:
        return empty

    out = torch.zeros((2, total_samples), dtype=torch.float32)
    file_key = "videoFile" if override_audio else "audioFile"

    from . import minimax_plan as plan   # the planner's own test: mixdown and plan must agree

    for seg in audio_segs:
        # A clip that cannot reach the window adds nothing, and reference clips are routinely
        # parked outside it — decide that before decoding up to 15s of file to add zero samples.
        if not plan.overlaps(seg, start_frame, start_frame + duration_frames):
            continue
        buffer = None
        if seg.get(file_key):
            path = resolve_input_path(seg[file_key])
            if path:
                with open(path, "rb") as f:
                    buffer = _io.BytesIO(f.read())
        if not override_audio and buffer is None and seg.get("audioB64"):
            try:
                b64 = seg["audioB64"]
                if "," in b64:
                    b64 = b64.split(",", 1)[1]
                buffer = _io.BytesIO(base64.b64decode(b64))
            except Exception:
                pass
        if buffer is None:
            continue

        try:
            waveform = _decode_audio_stereo(buffer)
            if waveform is None:
                continue

            trim_start = float(seg.get("trimStart", 0))
            length = float(seg.get("length", 1))
            seg_start = float(seg.get("start", 0))

            if seg_start + length <= start_frame:
                continue
            offset = max(0, start_frame - seg_start)
            trim_start += offset
            length = max(1, length - offset)
            seg_start = max(0, seg_start - start_frame)

            src_a = max(0, int(trim_start / frame_rate * AUDIO_SR))
            src_b = min(waveform.shape[1], src_a + int(length / frame_rate * AUDIO_SR))
            n = src_b - src_a
            if n <= 0:
                continue

            dst_a = int(seg_start / frame_rate * AUDIO_SR)
            if dst_a >= out.shape[1]:
                continue
            n = min(n, out.shape[1] - dst_a)
            if n <= 0:
                continue

            # additive mix so overlapping clips sum, matching the editor's preview
            out[:, dst_a:dst_a + n] += waveform[:, src_a:src_a + n]
        except Exception as e:
            log.warning("[MiniMaxDirector] Audio process error for segment %s: %s", seg.get("fileName"), e)
            continue

    return {"waveform": out.unsqueeze(0), "sample_rate": AUDIO_SR}
